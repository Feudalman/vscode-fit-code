#!/usr/bin/env node
/**
 * 不用 VSCode 命令面板，直接对真实安装跑 fitcode 的命令。
 *
 *   node test/apply.cjs status    # 看当前安装态 + 运行时配置
 *   node test/apply.cjs enable    # 打补丁（写 bundle / workbench.html / fitcode.config.json）
 *   node test/apply.cjs disable   # 从备份还原
 *   node test/apply.cjs install   # 把仓库里的扩展代码同步到 ~/.vscode/extensions/local.fitcode-<version>/
 *
 * 原理：把 `vscode` 模块 stub 掉（扩展只用 workspace.getConfiguration / window.* /
 * commands.registerCommand），配置值从用户 settings.json 里读，所以生成的运行时配置
 * 和你当前设置一致。命令跑完后需要重载 VSCode 窗口才会生效。
 *
 * 可用 FITCODE_APP_ROOT 覆盖安装目录的 out 目录：
 *   FITCODE_APP_ROOT="/Applications/Visual Studio Code.app/Contents/Resources/app/out" node test/apply.cjs status
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const EXT_DIR_NAME = `${PKG.publisher}.${PKG.name}-${PKG.version}`;
const HOME = os.homedir();
const EXT_ROOT = path.join(HOME, '.vscode', 'extensions');

const APP_ROOT = process.env.FITCODE_APP_ROOT
	|| '/Applications/Visual Studio Code.app/Contents/Resources/app/out';

// ---------- 读用户设置（VS Code 的 settings.json 允许注释，做个轻量剥离）----------
// 候选设置文件：先默认 profile，再各命名 profile（后者覆盖前者）
function settingsFiles() {
	const roots = [
		path.join(HOME, 'Library/Application Support/Code/User'),   // macOS
		path.join(HOME, '.config/Code/User'),                       // Linux
		process.env.APPDATA && path.join(process.env.APPDATA, 'Code/User'), // Windows
	].filter(Boolean);
	const files = [];
	for (const root of roots) {
		files.push(path.join(root, 'settings.json'));
		try {
			for (const d of fs.readdirSync(path.join(root, 'profiles'))) {
				files.push(path.join(root, 'profiles', d, 'settings.json'));
			}
		} catch (e) { /* 没有 profiles 目录 */ }
	}
	return files.filter((f) => fs.existsSync(f));
}
function readUserSettings() {
	const merged = {};
	for (const file of settingsFiles()) {
		try {
			const raw = fs.readFileSync(file, 'utf8')
				.replace(/^\s*\/\/.*$/gm, '')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/,(\s*[}\]])/g, '$1');
			Object.assign(merged, JSON.parse(raw));
		} catch (e) { /* 跳过读不了的 */ }
	}
	return merged;
}
const USER_SETTINGS = readUserSettings();
function settingValue(dotted) {
	return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), USER_SETTINGS);
}

// ---------- vscode 模块 stub ----------
const stub = {
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	workspace: {
		getConfiguration(section) {
			return {
				get: (key) => settingValue(`${section}.${key}`),
				update: async () => { /* 状态写入，忽略 */ },
			};
		},
		onDidChangeConfiguration: () => ({ dispose() {} }),
	},
	window: {
		activeTextEditor: null,
		tabGroups: { all: [] },
		showInformationMessage: async (msg) => { console.log(msg); return undefined; },
		showErrorMessage: async (msg) => { console.error('ERROR: ' + msg); return undefined; },
	},
	commands: {
		_cmds: {},
		registerCommand(name, fn) { this._cmds[name] = fn; return { dispose() {} }; },
		executeCommand: async () => {},
	},
};
const origLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') return stub;
	return origLoad.apply(this, arguments);
};

process.env.FITCODE_APP_ROOT = APP_ROOT;

function installExtension() {
	const dst = path.join(EXT_ROOT, EXT_DIR_NAME);
	for (const f of ['src/extension.js', 'media/inject.js', 'package.json', 'README.md']) {
		const target = path.join(dst, f);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(REPO, f), target);
	}
	console.log(`已同步扩展代码到 ${dst}`);
	try {
		for (const d of fs.readdirSync(EXT_ROOT)) {
			if (d === EXT_DIR_NAME) continue;
			if (d.startsWith(`${PKG.publisher}.${PKG.name}-`) || d.startsWith('local.center-editor-')) {
				console.log(`注意：存在旧版本目录，可手动删除：${path.join(EXT_ROOT, d)}`);
			}
		}
	} catch (e) { /* ignore */ }
	console.log('接着跑：node test/apply.cjs enable，然后重载 VSCode 窗口');
}

async function main() {
	const action = (process.argv[2] || '').toLowerCase();

	if (action === 'install') {
		installExtension();
		return;
	}

	const command = { enable: 'fitcode.enable', disable: 'fitcode.disable', status: 'fitcode.status' }[action];
	if (!command) {
		console.error('用法: node test/apply.cjs <status|enable|disable|install>');
		process.exit(1);
	}

	const ext = require(path.join(REPO, 'src', 'extension.js'));
	ext.activate({ subscriptions: [] });
	const fn = stub.commands._cmds[command];
	if (!fn) {
		console.error(`扩展没有注册命令 ${command}（命令名是否被改过？）`);
		process.exit(1);
	}
	await fn();
	if (action !== 'status') console.log('完成。重载 VSCode 窗口后生效。');
}

main()
	.catch((e) => {
		console.error('失败:', e && e.message ? e.message : e);
		process.exitCode = 1;
	})
	.finally(() => {
		// 扩展的 activate() 里挂了一个 setInterval（开发用的分屏监视器），这里直接退出
		process.exit(process.exitCode || 0);
	});
