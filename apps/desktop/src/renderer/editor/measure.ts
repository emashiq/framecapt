import type { TextMeasure } from './model/hit-test';
import { textFont } from './model/types';

let scratch: CanvasRenderingContext2D | null | undefined;

/** Measures text with the real canvas font engine, so hit boxes and handles match the pixels. */
export const measureText: TextMeasure = (text, fontSize, fontWeight, family, italic) => {
  scratch ??= document.createElement('canvas').getContext('2d');
  if (!scratch) return text.length * fontSize * 0.56;
  scratch.font = textFont(fontSize, fontWeight, family, italic);
  return scratch.measureText(text).width;
};
