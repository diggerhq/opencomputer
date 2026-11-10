import { describe, expect, it } from 'vitest';
import { commandKinds } from './command-kinds.js';

describe('commandKinds', () => {
  it('names what a command was for, several at once', () => {
    expect(commandKinds('cd /tmp/shots && npm link playwright && node shot.mjs')).toEqual(['install']);
    expect(commandKinds('npx playwright screenshot https://x.test out.png && calvin-send-file out.png the page')).toEqual(['browser', 'post']);
    expect(commandKinds('ffmpeg -framerate 30 -i f%03d.png out.mp4')).toEqual(['media']);
    expect(commandKinds('dot -Tpng graph.dot -o graph.png')).toEqual(['media']);
    expect(commandKinds('cd /tmp/debs && apt-get download libgbm1 && dpkg -x libgbm1.deb x')).toEqual(['install']);
    expect(commandKinds('PORT=5179 npm run dev > /tmp/dev.log 2>&1 &')).toEqual(['server', 'build']);
    expect(commandKinds('git status && gh pr view 54')).toEqual(['git']);
    expect(commandKinds('npx vitest run src/runner')).toEqual(['build']);
    expect(commandKinds('yarn && yarn test')).toEqual(['install', 'build']);
    expect(commandKinds('LD_LIBRARY_PATH=/tmp/x/lib chromium --headless --screenshot=a.png https://x.test')).toEqual(['browser']);
  });

  it('matches commands, not mentions', () => {
    expect(commandKinds('cat playwright.config.ts')).toEqual([]);
    expect(commandKinds('ls ~/.cache/ms-playwright && pkill -f chromium')).toEqual([]);
    expect(commandKinds('grep -rn puppeteer src | head')).toEqual([]);
    expect(commandKinds('git log --grep chromium')).toEqual(['git']);
    expect(commandKinds('npx playwright test e2e/')).toEqual([]);
    expect(commandKinds('git commit -m "make the thing work"')).toEqual(['git']);
    expect(commandKinds('echo "make sure" && curl https://x.test/jest')).toEqual([]);
    expect(commandKinds('npm install &&\nnpm test')).toEqual(['install', 'build']);
    expect(commandKinds('yarn build')).toEqual(['build']);
  });

  it('is empty for anything else, and for input that is not a command', () => {
    expect(commandKinds('ls -la')).toEqual([]);
    expect(commandKinds(undefined)).toEqual([]);
  });
});
