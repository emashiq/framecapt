import { describe, expect, it } from 'vitest';
import { buildGuideHtml, escapeHtml } from '../../src/main/flows/export-html';
import {
  frameName,
  gifSlideshowArgs,
  mp4SlideshowArgs,
  SLIDE_SECONDS,
  slideshowSize,
} from '../../src/main/flows/slideshow';
import { safeFileStem } from '../../src/shared/flow';

const png = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('escapeHtml', () => {
  it('escapes everything that could become markup', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')"> & more`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; more',
    );
  });
});

describe('buildGuideHtml', () => {
  const html = buildGuideHtml({
    title: '</title><script>alert(1)</script>',
    generated: '7 October 2026',
    steps: [
      { caption: '<b onmouseover="x()">Click</b> Save & "close"', png: png('one') },
      { caption: '   ', png: png('two') },
      { caption: 'Line one\nline two', png: png('three') },
    ],
  });

  it('is a complete page with the date, the count and every picture inline', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('3 steps');
    expect(html).toContain('Created with FrameCapt on 7 October 2026');
    expect(html.match(/<img /g)).toHaveLength(3);
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from('one').toString('base64')}"`);
  });

  it('escapes the title and every caption: nothing typed becomes a tag or an attribute', () => {
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).toContain(
      '&lt;b onmouseover=&quot;x()&quot;&gt;Click&lt;/b&gt; Save &amp; &quot;close&quot;',
    );
    expect(html).not.toContain('<b onmouseover');
    expect(html.match(/<script/gi)).toBeNull();
  });

  it('holds no script and no address of any kind except its own data pictures', () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(html).not.toMatch(/<(link|iframe|object|embed|form|base)\b/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/\s(href|action|poster|srcset)=/i);
    for (const match of html.matchAll(/\ssrc="([^"]*)"/g)) {
      expect(match[1]).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    }
    // The page forbids loading anything itself.
    expect(html).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  });

  it('numbers the steps and names an uncaptioned one "Step N"', () => {
    expect(html).toContain('<span class="num">2</span><p class="caption empty">Step 2</p>');
    expect(html).toContain('alt="Step 2"');
    expect(html).toContain(
      'alt="Step 1: &lt;b onmouseover=&quot;x()&quot;&gt;Click&lt;/b&gt; Save &amp; &quot;close&quot;"',
    );
  });

  it('says "1 step" for one', () => {
    const one = buildGuideHtml({
      title: 'T',
      generated: 'today',
      steps: [{ caption: 'a', png: png('x') }],
    });
    expect(one).toContain('1 step ·');
  });
});

describe('safeFileStem', () => {
  it('makes a title safe as a Windows file name', () => {
    expect(safeFileStem('My <guide>: "a/b" | c?*')).toBe('My guide a b c');
    expect(safeFileStem('ends with dots...  ')).toBe('ends with dots');
    expect(safeFileStem('   ')).toBe('Step guide');
    expect(safeFileStem('x'.repeat(200))).toHaveLength(80);
    expect(safeFileStem('tab\tand\nnewline')).toBe('tab and newline');
  });
});

describe('slideshow arguments', () => {
  const size = { width: 1280, height: 720 };
  const dir = 'C:/tmp/export-1';

  it('fits the first picture into the box without enlarging, with even sides', () => {
    expect(slideshowSize('mp4', { width: 3840, height: 2160 })).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(slideshowSize('mp4', { width: 1280, height: 720 })).toEqual({
      width: 1280,
      height: 720,
    });
    expect(slideshowSize('mp4', { width: 641, height: 361 })).toEqual({ width: 640, height: 360 });
    expect(slideshowSize('gif', { width: 1920, height: 1080 })).toEqual({
      width: 960,
      height: 540,
    });
    expect(slideshowSize('mp4', { width: 1, height: 1 })).toEqual({ width: 2, height: 2 });
  });

  it('numbers the pictures from 0001', () => {
    expect(frameName(0)).toBe('frame-0001.png');
    expect(frameName(199)).toBe('frame-0200.png');
    expect(SLIDE_SECONDS).toBe(2.5);
  });

  it('MP4: one picture per 2.5 s, H.264 4:2:0 at a constant rate, faststart, only the file protocol', () => {
    const args = mp4SlideshowArgs({ dir, size, output: 'C:/out/guide.mp4' });
    const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(at('-protocol_whitelist')).toBe('file');
    expect(at('-framerate')).toBe('0.4');
    expect(at('-i')).toBe('C:/tmp/export-1/frame-%04d.png');
    expect(at('-r')).toBe('30');
    expect(at('-c:v')).toBe('libx264');
    expect(args).toContain('+faststart');
    expect(at('-vf')).toBe(
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p',
    );
    expect(args.at(-1)).toBe('C:/out/guide.mp4');
    expect(args.every((arg) => typeof arg === 'string')).toBe(true);
  });

  it('GIF: 10 frames a second with a palette per picture, looping', () => {
    const gif = gifSlideshowArgs({ dir, size, output: 'C:/out/guide.gif' });
    expect(gif[gif.indexOf('-r') + 1]).toBe('10');
    expect(gif[gif.indexOf('-vf') + 1]).toContain('palettegen=stats_mode=single');
    expect(gif[gif.indexOf('-vf') + 1]).toContain('paletteuse=new=1');
    expect(gif[gif.indexOf('-vf') + 1]).not.toContain('fps=');
    expect(gif.slice(gif.indexOf('-loop'), gif.indexOf('-loop') + 2)).toEqual(['-loop', '0']);
    expect(gif).not.toContain('libx264');
    expect(gif.at(-1)).toBe('C:/out/guide.gif');
  });

  it('a Windows path is written with forward slashes', () => {
    const args = mp4SlideshowArgs({ dir: 'C:\\tmp\\export-1', size, output: 'C:\\out\\guide.mp4' });
    expect(args[args.indexOf('-i') + 1]).toBe('C:/tmp/export-1/frame-%04d.png');
  });

  it('refuses a relative path, which ffmpeg could read as an option', () => {
    expect(() => mp4SlideshowArgs({ dir: '-evil', size, output: 'C:/o.mp4' })).toThrow();
    expect(() => mp4SlideshowArgs({ dir, size, output: 'out.mp4' })).toThrow();
    expect(() => gifSlideshowArgs({ dir, size, output: 'o.gif' })).toThrow();
  });
});
