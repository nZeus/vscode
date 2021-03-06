/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';

import * as electron from './utils/electron';
import { Reader } from './utils/wireProtocol';

import { workspace, window, Uri, CancellationToken, Disposable, Memento, MessageItem, QuickPickItem, EventEmitter, Event, commands, WorkspaceConfiguration } from 'vscode';
import * as Proto from './protocol';
import { ITypescriptServiceClient, ITypescriptServiceClientHost, API } from './typescriptService';
import { TypeScriptServerPlugin } from './utils/plugins';
import Logger from './utils/logger';

import VersionStatus from './utils/versionStatus';
import * as is from './utils/is';
import TelemetryReporter from './utils/telemetry';
import Tracer from './utils/tracer';

import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

interface CallbackItem {
	c: (value: any) => void;
	e: (err: any) => void;
	start: number;
}

class CallbackMap {
	private callbacks: Map<number, CallbackItem> = new Map();
	public pendingResponses: number = 0;

	public destroy(e: any): void {
		for (const callback of this.callbacks.values()) {
			callback.e(e);
		}
		this.callbacks = new Map();
		this.pendingResponses = 0;
	}

	public add(seq: number, callback: CallbackItem) {
		this.callbacks.set(seq, callback);
		++this.pendingResponses;
	}

	public fetch(seq: number): CallbackItem | undefined {
		const callback = this.callbacks.get(seq);
		this.delete(seq);
		return callback;
	}

	private delete(seq: number) {
		if (this.callbacks.delete(seq)) {
			--this.pendingResponses;
		}
	}
}

interface RequestItem {
	request: Proto.Request;
	promise: Promise<any> | null;
	callbacks: CallbackItem | null;
}

enum TsServerLogLevel {
	Off,
	Normal,
	Terse,
	Verbose,
}

namespace TsServerLogLevel {
	export function fromString(value: string): TsServerLogLevel {
		switch (value && value.toLowerCase()) {
			case 'normal':
				return TsServerLogLevel.Normal;
			case 'terse':
				return TsServerLogLevel.Terse;
			case 'verbose':
				return TsServerLogLevel.Verbose;
			case 'off':
			default:
				return TsServerLogLevel.Off;
		}
	}

	export function toString(value: TsServerLogLevel): string {
		switch (value) {
			case TsServerLogLevel.Normal:
				return 'normal';
			case TsServerLogLevel.Terse:
				return 'terse';
			case TsServerLogLevel.Verbose:
				return 'verbose';
			case TsServerLogLevel.Off:
			default:
				return 'off';
		}
	}
}

enum MessageAction {
	useLocal,
	useBundled,
	learnMore,
	reportIssue
}

interface MyQuickPickItem extends QuickPickItem {
	id: MessageAction;
}

interface MyMessageItem extends MessageItem {
	id: MessageAction;
}

class TypeScriptServiceConfiguration {
	public readonly globalTsdk: string | null;
	public readonly localTsdk: string | null;
	public readonly npmLocation: string | null;
	public readonly tsServerLogLevel: TsServerLogLevel = TsServerLogLevel.Off;
	public readonly checkJs: boolean;

	public static loadFromWorkspace(): TypeScriptServiceConfiguration {
		return new TypeScriptServiceConfiguration();
	}

	private constructor() {
		const configuration = workspace.getConfiguration();

		this.globalTsdk = TypeScriptServiceConfiguration.extractGlobalTsdk(configuration);
		this.localTsdk = TypeScriptServiceConfiguration.extractLocalTsdk(configuration);
		this.npmLocation = TypeScriptServiceConfiguration.readNpmLocation(configuration);
		this.tsServerLogLevel = TypeScriptServiceConfiguration.readTsServerLogLevel(configuration);
		this.checkJs = TypeScriptServiceConfiguration.readCheckJs(configuration);
	}

	public isEqualTo(other: TypeScriptServiceConfiguration): boolean {
		return this.globalTsdk === other.globalTsdk
			&& this.localTsdk === other.localTsdk
			&& this.npmLocation === other.npmLocation
			&& this.tsServerLogLevel === other.tsServerLogLevel
			&& this.checkJs === other.checkJs;
	}

	private static extractGlobalTsdk(configuration: WorkspaceConfiguration): string | null {
		let inspect = configuration.inspect('typescript.tsdk');
		if (inspect && inspect.globalValue && 'string' === typeof inspect.globalValue) {
			return inspect.globalValue;
		}
		if (inspect && inspect.defaultValue && 'string' === typeof inspect.defaultValue) {
			return inspect.defaultValue;
		}
		return null;
	}

	private static extractLocalTsdk(configuration: WorkspaceConfiguration): string | null {
		let inspect = configuration.inspect('typescript.tsdk');
		if (inspect && inspect.workspaceValue && 'string' === typeof inspect.workspaceValue) {
			return inspect.workspaceValue;
		}
		return null;
	}

	private static readTsServerLogLevel(configuration: WorkspaceConfiguration): TsServerLogLevel {
		const setting = configuration.get<string>('typescript.tsserver.log', 'off');
		return TsServerLogLevel.fromString(setting);
	}

	private static readCheckJs(configuration: WorkspaceConfiguration): boolean {
		return configuration.get<boolean>('javascript.implicitProjectConfig.checkJs', false);
	}

	private static readNpmLocation(configuration: WorkspaceConfiguration): string | null {
		return configuration.get<string | null>('typescript.npm', null);
	}
}

class RequestQueue {
	private queue: RequestItem[] = [];
	private sequenceNumber: number = 0;

	public get length(): number {
		return this.queue.length;
	}

	public push(item: RequestItem): void {
		this.queue.push(item);
	}

	public shift(): RequestItem | undefined {
		return this.queue.shift();
	}

	public tryCancelPendingRequest(seq: number): boolean {
		for (let i = 0; i < this.queue.length; i++) {
			if (this.queue[i].request.seq === seq) {
				this.queue.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	public createRequest(command: string, args: any): Proto.Request {
		return {
			seq: this.sequenceNumber++,
			type: 'request',
			command: command,
			arguments: args
		};
	}
}

export default class TypeScriptServiceClient implements ITypescriptServiceClient {
	private static useWorkspaceTsdkStorageKey = 'typescript.useWorkspaceTsdk';
	private static tsdkMigratedStorageKey = 'typescript.tsdkMigrated';

	private static readonly WALK_THROUGH_SNIPPET_SCHEME = 'walkThroughSnippet';
	private static readonly WALK_THROUGH_SNIPPET_SCHEME_COLON = `${TypeScriptServiceClient.WALK_THROUGH_SNIPPET_SCHEME}:`;

	private pathSeparator: string;
	private modulePath: string | undefined;

	private _onReady: { promise: Promise<void>; resolve: () => void; reject: () => void; };
	private configuration: TypeScriptServiceConfiguration;
	private _checkGlobalTSCVersion: boolean;
	private tracer: Tracer;
	private readonly logger: Logger = new Logger();
	private tsServerLogFile: string | null = null;
	private servicePromise: Thenable<cp.ChildProcess> | null;
	private lastError: Error | null;
	private reader: Reader<Proto.Response>;
	private firstStart: number;
	private lastStart: number;
	private numberRestarts: number;
	private isRestarting: boolean = false;

	private cancellationPipeName: string | null = null;

	private requestQueue: RequestQueue;
	private callbacks: CallbackMap;

	private readonly _onTsServerStarted = new EventEmitter<void>();
	private readonly _onProjectLanguageServiceStateChanged = new EventEmitter<Proto.ProjectLanguageServiceStateEventBody>();
	private readonly _onDidBeginInstallTypings = new EventEmitter<Proto.BeginInstallTypesEventBody>();
	private readonly _onDidEndInstallTypings = new EventEmitter<Proto.EndInstallTypesEventBody>();
	private readonly _onTypesInstallerInitializationFailed = new EventEmitter<Proto.TypesInstallerInitializationFailedEventBody>();

	private _apiVersion: API;
	private telemetryReporter: TelemetryReporter;

	constructor(
		private readonly host: ITypescriptServiceClientHost,
		private readonly workspaceState: Memento,
		private readonly versionStatus: VersionStatus,
		private readonly plugins: TypeScriptServerPlugin[],
		disposables: Disposable[]
	) {
		this.pathSeparator = path.sep;
		this.lastStart = Date.now();

		var p = new Promise<void>((resolve, reject) => {
			this._onReady = { promise: p, resolve, reject };
		});
		this._onReady.promise = p;

		this.servicePromise = null;
		this.lastError = null;
		this.firstStart = Date.now();
		this.numberRestarts = 0;

		this.requestQueue = new RequestQueue();
		this.callbacks = new CallbackMap();
		this.configuration = TypeScriptServiceConfiguration.loadFromWorkspace();

		this._apiVersion = new API('1.0.0');
		this._checkGlobalTSCVersion = true;
		this.tracer = new Tracer(this.logger);

		disposables.push(workspace.onDidChangeConfiguration(() => {
			const oldConfiguration = this.configuration;
			this.configuration = TypeScriptServiceConfiguration.loadFromWorkspace();

			this.tracer.updateConfiguration();

			if (this.servicePromise) {
				if (this.configuration.checkJs !== oldConfiguration.checkJs) {
					this.setCompilerOptionsForInferredProjects();
				}

				if (!this.configuration.isEqualTo(oldConfiguration)) {
					this.restartTsServer();
				}
			}
		}));
		this.telemetryReporter = new TelemetryReporter();
		disposables.push(this.telemetryReporter);
		this.startService();
	}

	public restartTsServer(): void {
		const start = () => {
			this.servicePromise = this.startService(true);
			return this.servicePromise;
		};

		if (this.servicePromise) {
			this.servicePromise = this.servicePromise.then(cp => {
				if (cp) {
					this.isRestarting = true;
					cp.kill();
				}
			}).then(start);
		} else {
			start();
		}
	}

	get onTsServerStarted(): Event<void> {
		return this._onTsServerStarted.event;
	}

	get onProjectLanguageServiceStateChanged(): Event<Proto.ProjectLanguageServiceStateEventBody> {
		return this._onProjectLanguageServiceStateChanged.event;
	}

	get onDidBeginInstallTypings(): Event<Proto.BeginInstallTypesEventBody> {
		return this._onDidBeginInstallTypings.event;
	}

	get onDidEndInstallTypings(): Event<Proto.EndInstallTypesEventBody> {
		return this._onDidEndInstallTypings.event;
	}

	get onTypesInstallerInitializationFailed(): Event<Proto.TypesInstallerInitializationFailedEventBody> {
		return this._onTypesInstallerInitializationFailed.event;
	}

	public get checkGlobalTSCVersion(): boolean {
		return this._checkGlobalTSCVersion;
	}

	public get apiVersion(): API {
		return this._apiVersion;
	}

	public onReady(): Promise<void> {
		return this._onReady.promise;
	}

	private info(message: string, data?: any): void {
		this.logger.info(message, data);
	}

	public warn(message: string, data?: any): void {
		this.logger.warn(message, data);
	}

	private error(message: string, data?: any): void {
		this.logger.error(message, data);
	}

	public logTelemetry(eventName: string, properties?: { [prop: string]: string }) {
		this.telemetryReporter.logTelemetry(eventName, properties);
	}

	private service(): Thenable<cp.ChildProcess> {
		if (this.servicePromise) {
			return this.servicePromise;
		}
		if (this.lastError) {
			return Promise.reject<cp.ChildProcess>(this.lastError);
		}
		this.startService();
		if (this.servicePromise) {
			return this.servicePromise;
		}
		return Promise.reject<cp.ChildProcess>(new Error('Could not create TS service'));
	}

	private get bundledTypeScriptPath(): string {
		try {
			return require.resolve('typescript/lib/tsserver.js');
		} catch (e) {
			return '';
		}
	}

	private get localTypeScriptPath(): string | null {
		if (!workspace.rootPath) {
			return null;
		}

		if (this.configuration.localTsdk) {
			this._checkGlobalTSCVersion = false;
			if ((<any>path).isAbsolute(this.configuration.localTsdk)) {
				return path.join(this.configuration.localTsdk, 'tsserver.js');
			}
			return path.join(workspace.rootPath, this.configuration.localTsdk, 'tsserver.js');
		}

		const localModulePath = path.join(workspace.rootPath, 'node_modules', 'typescript', 'lib', 'tsserver.js');
		if (fs.existsSync(localModulePath) && this.getTypeScriptVersion(localModulePath)) {
			return localModulePath;
		}
		return null;
	}

	private get globalTypescriptPath(): string {
		if (this.configuration.globalTsdk) {
			this._checkGlobalTSCVersion = false;
			if ((<any>path).isAbsolute(this.configuration.globalTsdk)) {
				return path.join(this.configuration.globalTsdk, 'tsserver.js');
			} else if (workspace.rootPath) {
				return path.join(workspace.rootPath, this.configuration.globalTsdk, 'tsserver.js');
			}
		}

		return this.bundledTypeScriptPath;
	}

	private hasWorkspaceTsdkSetting(): boolean {
		return !!this.configuration.localTsdk;
	}

	private startService(resendModels: boolean = false): Thenable<cp.ChildProcess> {
		let modulePath: Thenable<string> = Promise.resolve(this.globalTypescriptPath);

		if (!this.workspaceState.get<boolean>(TypeScriptServiceClient.tsdkMigratedStorageKey, false)) {
			this.workspaceState.update(TypeScriptServiceClient.tsdkMigratedStorageKey, true);
			if (workspace.rootPath && this.hasWorkspaceTsdkSetting()) {
				modulePath = this.showVersionPicker(true);
			}
		}

		return modulePath.then(modulePath => {
			if (this.workspaceState.get<boolean>(TypeScriptServiceClient.useWorkspaceTsdkStorageKey, false)) {
				if (workspace.rootPath) {
					// TODO: check if we need better error handling
					return this.localTypeScriptPath || modulePath;
				}
			}
			return modulePath;
		}).then(modulePath => {
			return this.getDebugPort().then(debugPort => ({ modulePath, debugPort }));
		}).then(({ modulePath, debugPort }) => {
			return this.servicePromise = new Promise<cp.ChildProcess>((resolve, reject) => {
				this.info(`Using tsserver from: ${modulePath}`);
				if (!fs.existsSync(modulePath)) {
					window.showWarningMessage(localize('noServerFound', 'The path {0} doesn\'t point to a valid tsserver install. Falling back to bundled TypeScript version.', modulePath ? path.dirname(modulePath) : ''));
					if (!this.bundledTypeScriptPath) {
						window.showErrorMessage(localize('noBundledServerFound', 'VSCode\'s tsserver was deleted by another application such as a misbehaving virus detection tool. Please reinstall VS Code.'));
						return reject(new Error('Could not find bundled tsserver.js'));
					}
					modulePath = this.bundledTypeScriptPath;
				}

				let version = this.getTypeScriptVersion(modulePath);
				if (!version) {
					version = workspace.getConfiguration().get<string | undefined>('typescript.tsdk_version', undefined);
				}
				if (version) {
					this._apiVersion = new API(version);
				}

				const label = version || localize('versionNumber.custom', 'custom');
				const tooltip = modulePath;
				this.modulePath = modulePath;
				this.versionStatus.showHideStatus();
				this.versionStatus.setInfo(label, tooltip);


				this.requestQueue = new RequestQueue();
				this.callbacks = new CallbackMap();
				this.lastError = null;

				try {
					const options: electron.IForkOptions = {
						execArgv: [] // [`--debug-brk=5859`]
					};
					if (workspace.rootPath) {
						options.cwd = workspace.rootPath;
					}

					if (debugPort && !isNaN(debugPort)) {
						this.info(`TSServer started in debug mode using port ${debugPort}`);
						options.execArgv = [`--debug=${debugPort}`];
					}

					const args: string[] = [];
					if (this.apiVersion.has206Features()) {
						args.push('--useSingleInferredProject');
						if (workspace.getConfiguration().get<boolean>('typescript.disableAutomaticTypeAcquisition', false)) {
							args.push('--disableAutomaticTypingAcquisition');
						}
					}
					if (this.apiVersion.has208Features()) {
						args.push('--enableTelemetry');
					}
					if (this.apiVersion.has222Features()) {
						this.cancellationPipeName = electron.getTempFile(`tscancellation-${electron.makeRandomHexString(20)}`);
						args.push('--cancellationPipeName', this.cancellationPipeName + '*');
					}

					if (this.apiVersion.has222Features()) {
						if (this.configuration.tsServerLogLevel !== TsServerLogLevel.Off) {
							try {
								const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `vscode-tsserver-log-`));
								this.tsServerLogFile = path.join(logDir, `tsserver.log`);
								this.info(`TSServer log file: ${this.tsServerLogFile}`);
							} catch (e) {
								this.error('Could not create TSServer log directory');
							}

							if (this.tsServerLogFile) {
								args.push('--logVerbosity', TsServerLogLevel.toString(this.configuration.tsServerLogLevel));
								args.push('--logFile', this.tsServerLogFile);
							}
						}
					}

					if (this.apiVersion.has230Features()) {
						if (this.plugins.length) {
							args.push('--globalPlugins', this.plugins.map(x => x.name).join(','));
							if (modulePath === this.globalTypescriptPath) {
								args.push('--pluginProbeLocations', this.plugins.map(x => x.path).join(','));
							}
						}
					}

					if (this.apiVersion.has234Features()) {
						if (this.configuration.npmLocation) {
							args.push('--npmLocation', `"${this.configuration.npmLocation}"`);
						}
					}

					electron.fork(modulePath, args, options, this.logger, (err: any, childProcess: cp.ChildProcess) => {
						if (err) {
							this.lastError = err;
							this.error('Starting TSServer failed with error.', err);
							window.showErrorMessage(localize('serverCouldNotBeStarted', 'TypeScript language server couldn\'t be started. Error message is: {0}', err.message || err));
							this.logTelemetry('error', { message: err.message });
							return;
						}
						this.lastStart = Date.now();
						childProcess.on('error', (err: Error) => {
							this.lastError = err;
							this.error('TSServer errored with error.', err);
							if (this.tsServerLogFile) {
								this.error(`TSServer log file: ${this.tsServerLogFile}`);
							}
							this.logTelemetry('tsserver.error');
							this.serviceExited(false);
						});
						childProcess.on('exit', (code: any) => {
							if (code === null || typeof code === 'undefined') {
								this.info(`TSServer exited`);
							} else {
								this.error(`TSServer exited with code: ${code}`);
								this.logTelemetry('tsserver.exitWithCode', { code: code });
							}

							if (this.tsServerLogFile) {
								this.info(`TSServer log file: ${this.tsServerLogFile}`);
							}
							this.serviceExited(!this.isRestarting);
							this.isRestarting = false;
						});

						this.reader = new Reader<Proto.Response>(
							childProcess.stdout,
							(msg) => { this.dispatchMessage(msg); },
							error => { this.error('ReaderError', error); });

						this._onReady.resolve();
						resolve(childProcess);
						this._onTsServerStarted.fire();

						this.serviceStarted(resendModels);
					});
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	private getDebugPort(): Promise<number | undefined> {
		const value = process.env.TSS_DEBUG;
		if (value) {
			const port = parseInt(value);
			if (!isNaN(port)) {
				return Promise.resolve(port);
			}
		}

		if (workspace.getConfiguration('typescript').get<boolean>('tsserver.debug', false)) {
			return Promise.race([
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
				new Promise<number | undefined>((resolve) => {
					const server = net.createServer(sock => sock.end());
					server.listen(0, function () {
						resolve(server.address().port);
					});
				})
			]);
		}

		return Promise.resolve(undefined);
	}

	public onVersionStatusClicked(): Thenable<string> {
		return this.showVersionPicker(false);
	}

	private showVersionPicker(firstRun: boolean): Thenable<string> {
		const modulePath = this.modulePath || this.globalTypescriptPath;
		if (!workspace.rootPath || !modulePath) {
			return Promise.resolve(modulePath);
		}

		const useWorkspaceVersionSetting = this.workspaceState.get<boolean>(TypeScriptServiceClient.useWorkspaceTsdkStorageKey, false);
		const shippedVersion = this.getTypeScriptVersion(this.globalTypescriptPath);
		const localModulePath = this.localTypeScriptPath;

		const pickOptions: MyQuickPickItem[] = [];

		pickOptions.push({
			label: localize('useVSCodeVersionOption', 'Use VSCode\'s Version'),
			description: shippedVersion || this.globalTypescriptPath,
			detail: modulePath === this.globalTypescriptPath && (modulePath !== localModulePath || !useWorkspaceVersionSetting) ? localize('activeVersion', 'Currently active') : '',
			id: MessageAction.useBundled,
		});

		if (localModulePath) {
			const localVersion = this.getTypeScriptVersion(localModulePath);
			pickOptions.push({
				label: localize('useWorkspaceVersionOption', 'Use Workspace Version'),
				description: localVersion || localModulePath,
				detail: modulePath === localModulePath && (modulePath !== this.globalTypescriptPath || useWorkspaceVersionSetting) ? localize('activeVersion', 'Currently active') : '',
				id: MessageAction.useLocal
			});
		}

		pickOptions.push({
			label: localize('learnMore', 'Learn More'),
			description: '',
			id: MessageAction.learnMore
		});

		const tryShowRestart = (newModulePath: string) => {
			if (firstRun || newModulePath === this.modulePath) {
				return;
			}
			this.restartTsServer();
		};

		return window.showQuickPick<MyQuickPickItem>(pickOptions, {
			placeHolder: localize(
				'selectTsVersion',
				'Select the TypeScript version used for JavaScript and TypeScript language features'),
			ignoreFocusOut: firstRun
		})
			.then(selected => {
				if (!selected) {
					return modulePath;
				}
				switch (selected.id) {
					case MessageAction.useLocal:
						return this.workspaceState.update(TypeScriptServiceClient.useWorkspaceTsdkStorageKey, true)
							.then(_ => {
								if (localModulePath) {
									tryShowRestart(localModulePath);
								}
								return localModulePath || '';
							});
					case MessageAction.useBundled:
						return this.workspaceState.update(TypeScriptServiceClient.useWorkspaceTsdkStorageKey, false)
							.then(_ => {
								tryShowRestart(this.globalTypescriptPath);
								return this.globalTypescriptPath;
							});
					case MessageAction.learnMore:
						commands.executeCommand('vscode.open', Uri.parse('https://go.microsoft.com/fwlink/?linkid=839919'));
						return modulePath;
					default:
						return modulePath;
				}
			});
	}

	public openTsServerLogFile(): Thenable<boolean> {
		if (!this.apiVersion.has222Features()) {
			return window.showErrorMessage(
				localize(
					'typescript.openTsServerLog.notSupported',
					'TS Server logging requires TS 2.2.2+'))
				.then(() => false);
		}

		if (this.configuration.tsServerLogLevel === TsServerLogLevel.Off) {
			return window.showErrorMessage<MessageItem>(
				localize(
					'typescript.openTsServerLog.loggingNotEnabled',
					'TS Server logging is off. Please set `typescript.tsserver.log` and restart the TS server to enable logging'),
				{
					title: localize(
						'typescript.openTsServerLog.enableAndReloadOption',
						'Enable logging and restart TS server'),
				})
				.then(selection => {
					if (selection) {
						return workspace.getConfiguration().update('typescript.tsserver.log', 'verbose', true).then(() => {
							this.restartTsServer();
							return false;
						});
					}
					return false;
				});
		}

		if (!this.tsServerLogFile) {
			return window.showWarningMessage(localize(
				'typescript.openTsServerLog.noLogFile',
				'TS Server has not started logging.')).then(() => false);
		}

		return commands.executeCommand('_workbench.action.files.revealInOS', Uri.parse(this.tsServerLogFile))
			.then(() => true, () => {
				window.showWarningMessage(localize(
					'openTsServerLog.openFileFailedFailed',
					'Could not open TS Server log file'));
				return false;
			});
	}

	private serviceStarted(resendModels: boolean): void {
		let configureOptions: Proto.ConfigureRequestArguments = {
			hostInfo: 'vscode'
		};
		this.execute('configure', configureOptions);
		this.setCompilerOptionsForInferredProjects();
		if (resendModels) {
			this.host.populateService();
		}
	}

	private setCompilerOptionsForInferredProjects(): void {
		if (!this.apiVersion.has206Features()) {
			return;
		}

		const compilerOptions: Proto.ExternalProjectCompilerOptions = {
			module: 'CommonJS',
			target: 'ES6',
			allowSyntheticDefaultImports: true,
			allowNonTsExtensions: true,
			allowJs: true,
			jsx: 'Preserve'
		};

		if (this.apiVersion.has230Features()) {
			compilerOptions.checkJs = workspace.getConfiguration('javascript').get<boolean>('implicitProjectConfig.checkJs', false);
		}

		const args: Proto.SetCompilerOptionsForInferredProjectsArgs = {
			options: compilerOptions
		};
		this.execute('compilerOptionsForInferredProjects', args, true).catch((err) => {
			this.error(`'compilerOptionsForInferredProjects' request failed with error.`, err);
		});
	}

	private getTypeScriptVersion(serverPath: string): string | undefined {
		if (!fs.existsSync(serverPath)) {
			return undefined;
		}

		let p = serverPath.split(path.sep);
		if (p.length <= 2) {
			return undefined;
		}
		let p2 = p.slice(0, -2);
		let modulePath = p2.join(path.sep);
		let fileName = path.join(modulePath, 'package.json');
		if (!fs.existsSync(fileName)) {
			return undefined;
		}
		let contents = fs.readFileSync(fileName).toString();
		let desc: any = null;
		try {
			desc = JSON.parse(contents);
		} catch (err) {
			return undefined;
		}
		if (!desc || !desc.version) {
			return undefined;
		}
		return desc.version;
	}

	private serviceExited(restart: boolean): void {
		this.servicePromise = null;
		this.tsServerLogFile = null;
		this.callbacks.destroy(new Error('Service died.'));
		this.callbacks = new CallbackMap();
		if (restart) {
			const diff = Date.now() - this.lastStart;
			this.numberRestarts++;
			let startService = true;
			if (this.numberRestarts > 5) {
				let prompt: Thenable<MyMessageItem | undefined> | undefined = undefined;
				this.numberRestarts = 0;
				if (diff < 10 * 1000 /* 10 seconds */) {
					this.lastStart = Date.now();
					startService = false;
					prompt = window.showErrorMessage<MyMessageItem>(
						localize('serverDiedAfterStart', 'The TypeScript language service died 5 times right after it got started. The service will not be restarted.'),
						{
							title: localize('serverDiedReportIssue', 'Report Issue'),
							id: MessageAction.reportIssue,
							isCloseAffordance: true
						});
					this.logTelemetry('serviceExited');
				} else if (diff < 60 * 1000 /* 1 Minutes */) {
					this.lastStart = Date.now();
					prompt = window.showWarningMessage<MyMessageItem>(
						localize('serverDied', 'The TypeScript language service died unexpectedly 5 times in the last 5 Minutes.'),
						{
							title: localize('serverDiedReportIssue', 'Report Issue'),
							id: MessageAction.reportIssue,
							isCloseAffordance: true
						});
				}
				if (prompt) {
					prompt.then(item => {
						if (item && item.id === MessageAction.reportIssue) {
							return commands.executeCommand('workbench.action.reportIssues');
						}
						return undefined;
					});
				}
			}
			if (startService) {
				this.startService(true);
			}
		}
	}

	public normalizePath(resource: Uri): string | null {
		if (resource.scheme === TypeScriptServiceClient.WALK_THROUGH_SNIPPET_SCHEME) {
			return resource.toString();
		}

		if (resource.scheme === 'untitled' && this._apiVersion.has213Features()) {
			return resource.toString();
		}

		if (resource.scheme !== 'file') {
			return null;
		}
		let result = resource.fsPath;
		if (!result) {
			return null;
		}
		// Both \ and / must be escaped in regular expressions
		return result.replace(new RegExp('\\' + this.pathSeparator, 'g'), '/');
	}

	public asUrl(filepath: string): Uri {
		if (filepath.startsWith(TypeScriptServiceClient.WALK_THROUGH_SNIPPET_SCHEME_COLON)
			|| (filepath.startsWith('untitled:') && this._apiVersion.has213Features())
		) {
			return Uri.parse(filepath);
		}
		return Uri.file(filepath);
	}

	public execute(command: string, args: any, expectsResultOrToken?: boolean | CancellationToken): Promise<any> {
		let token: CancellationToken | undefined = undefined;
		let expectsResult = true;
		if (typeof expectsResultOrToken === 'boolean') {
			expectsResult = expectsResultOrToken;
		} else {
			token = expectsResultOrToken;
		}

		const request = this.requestQueue.createRequest(command, args);
		const requestInfo: RequestItem = {
			request: request,
			promise: null,
			callbacks: null
		};
		let result: Promise<any> = Promise.resolve(null);
		if (expectsResult) {
			let wasCancelled = false;
			result = new Promise<any>((resolve, reject) => {
				requestInfo.callbacks = { c: resolve, e: reject, start: Date.now() };
				if (token) {
					token.onCancellationRequested(() => {
						wasCancelled = true;
						this.tryCancelRequest(request.seq);
					});
				}
			}).catch((err: any) => {
				if (!wasCancelled) {
					this.error(`'${command}' request failed with error.`, err);
				}
				throw err;
			});
		}
		requestInfo.promise = result;
		this.requestQueue.push(requestInfo);
		this.sendNextRequests();

		return result;
	}

	private sendNextRequests(): void {
		while (this.callbacks.pendingResponses === 0 && this.requestQueue.length > 0) {
			const item = this.requestQueue.shift();
			if (item) {
				this.sendRequest(item);
			}
		}
	}

	private sendRequest(requestItem: RequestItem): void {
		const serverRequest = requestItem.request;
		this.tracer.traceRequest(serverRequest, !!requestItem.callbacks, this.requestQueue.length);
		if (requestItem.callbacks) {
			this.callbacks.add(serverRequest.seq, requestItem.callbacks);
		}
		this.service()
			.then((childProcess) => {
				childProcess.stdin.write(JSON.stringify(serverRequest) + '\r\n', 'utf8');
			})
			.then(undefined, err => {
				const callback = this.callbacks.fetch(serverRequest.seq);
				if (callback) {
					callback.e(err);
				}
			});
	}

	private tryCancelRequest(seq: number): boolean {
		try {
			if (this.requestQueue.tryCancelPendingRequest(seq)) {
				this.tracer.logTrace(`TypeScript Service: canceled request with sequence number ${seq}`);
				return true;
			}

			if (this.apiVersion.has222Features() && this.cancellationPipeName) {
				this.tracer.logTrace(`TypeScript Service: trying to cancel ongoing request with sequence number ${seq}`);
				try {
					fs.writeFileSync(this.cancellationPipeName + seq, '');
				} catch (e) {
					// noop
				}
				return true;
			}

			this.tracer.logTrace(`TypeScript Service: tried to cancel request with sequence number ${seq}. But request got already delivered.`);
			return false;
		} finally {
			const p = this.callbacks.fetch(seq);
			if (p) {
				p.e(new Error(`Cancelled Request ${seq}`));
			}
		}
	}

	private dispatchMessage(message: Proto.Message): void {
		try {
			if (message.type === 'response') {
				const response: Proto.Response = message as Proto.Response;
				const p = this.callbacks.fetch(response.request_seq);
				if (p) {
					this.tracer.traceResponse(response, p.start);
					if (response.success) {
						p.c(response);
					} else {
						p.e(response);
					}
				}
			} else if (message.type === 'event') {
				const event: Proto.Event = <Proto.Event>message;
				this.tracer.traceEvent(event);
				this.dispatchEvent(event);
			} else {
				throw new Error('Unknown message type ' + message.type + ' recevied');
			}
		} finally {
			this.sendNextRequests();
		}
	}

	private dispatchEvent(event: Proto.Event) {
		if (event.event === 'syntaxDiag') {
			this.host.syntaxDiagnosticsReceived(event as Proto.DiagnosticEvent);
		} else if (event.event === 'semanticDiag') {
			this.host.semanticDiagnosticsReceived(event as Proto.DiagnosticEvent);
		} else if (event.event === 'configFileDiag') {
			this.host.configFileDiagnosticsReceived(event as Proto.ConfigFileDiagnosticEvent);
		} else if (event.event === 'telemetry') {
			const telemetryData = (event as Proto.TelemetryEvent).body;
			this.dispatchTelemetryEvent(telemetryData);
		} else if (event.event === 'projectLanguageServiceState') {
			const data = (event as Proto.ProjectLanguageServiceStateEvent).body;
			if (data) {
				this._onProjectLanguageServiceStateChanged.fire(data);
			}
		} else if (event.event === 'beginInstallTypes') {
			const data = (event as Proto.BeginInstallTypesEvent).body;
			if (data) {
				this._onDidBeginInstallTypings.fire(data);
			}
		} else if (event.event === 'endInstallTypes') {
			const data = (event as Proto.EndInstallTypesEvent).body;
			if (data) {
				this._onDidEndInstallTypings.fire(data);
			}
		} else if (event.event === 'typesInstallerInitializationFailed') {
			const data = (event as Proto.TypesInstallerInitializationFailedEvent).body;
			if (data) {
				this._onTypesInstallerInitializationFailed.fire(data);
			}
		}
	}

	private dispatchTelemetryEvent(telemetryData: Proto.TelemetryEventBody): void {
		const properties: ObjectMap<string> = Object.create(null);
		switch (telemetryData.telemetryEventName) {
			case 'typingsInstalled':
				const typingsInstalledPayload: Proto.TypingsInstalledTelemetryEventPayload = (telemetryData.payload as Proto.TypingsInstalledTelemetryEventPayload);
				properties['installedPackages'] = typingsInstalledPayload.installedPackages;

				if (is.defined(typingsInstalledPayload.installSuccess)) {
					properties['installSuccess'] = typingsInstalledPayload.installSuccess.toString();
				}
				if (is.string(typingsInstalledPayload.typingsInstallerVersion)) {
					properties['typingsInstallerVersion'] = typingsInstalledPayload.typingsInstallerVersion;
				}
				break;

			default:
				const payload = telemetryData.payload;
				if (payload) {
					Object.keys(payload).forEach((key) => {
						try {
							if (payload.hasOwnProperty(key)) {
								properties[key] = is.string(payload[key]) ? payload[key] : JSON.stringify(payload[key]);
							}
						} catch (e) {
							// noop
						}
					});
				}
				break;
		}
		this.logTelemetry(telemetryData.telemetryEventName, properties);
	}
}