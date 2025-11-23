const assert = require('assert');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require('vscode');
// const myExtension = require('../extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('alexyssh.vscode-spotify-widget'));
	});

	test('Commands should be registered', async () => {
		// Give extension time to fully activate and register commands
		await new Promise(resolve => setTimeout(resolve, 100));
		
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('spotify-widget.authenticate'));
		assert.ok(commands.includes('spotify-widget.show'));
		assert.ok(commands.includes('spotify-widget.hide'));
	});
});
