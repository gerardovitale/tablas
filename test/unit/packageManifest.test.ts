import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the parts of package.json that decide where the extension runs. They are plain JSON,
 * so a typo changes behaviour (or is silently ignored by VS Code) without any other test noticing.
 */
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  engines: { vscode: string; node: string };
  capabilities?: { untrustedWorkspaces?: { supported?: unknown; restrictedConfigurations?: unknown } };
  contributes: { configuration: { properties: Record<string, unknown> } };
};

describe('package.json', () => {
  it('requires a VS Code whose extension host runs Node 20 (VS Code 1.90 and newer), as the bundle targets', () => {
    const minimum = /^\^?(\d+)\.(\d+)\./.exec(manifest.engines.vscode);
    assert.ok(minimum, `unexpected engines.vscode: ${manifest.engines.vscode}`);
    const [major, minor] = [Number(minimum[1]), Number(minimum[2])];
    assert.ok(major > 1 || minor >= 90, `engines.vscode ${manifest.engines.vscode} admits hosts older than Node 20`);
  });

  it('declares limited Workspace Trust support, restricting only settings that exist', () => {
    const trust = manifest.capabilities?.untrustedWorkspaces;
    assert.strictEqual(trust?.supported, 'limited');
    const restricted = trust?.restrictedConfigurations;
    assert.ok(Array.isArray(restricted) && restricted.length > 0);
    for (const id of restricted as string[]) {
      assert.ok(id in manifest.contributes.configuration.properties, `${id} is not a contributed setting`);
    }
    assert.ok((restricted as string[]).includes('tablas.maxRows'), 'a workspace must not be able to set tablas.maxRows');
  });
});
