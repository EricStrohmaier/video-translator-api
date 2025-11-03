export interface FrameInfo {
  path: string;
  name: string;
  frameNumber: number;
}

export interface TextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  translatedText?: string;
}

export interface DetectionFrame {
  framePath: string;
  frameName: string;
  frameNumber: number;
  texts: TextBox[];
}

export interface GroupedFrame extends DetectionFrame {}

export type TranslationMap = Record<string, string>;
