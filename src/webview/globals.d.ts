/** Vendor CSS imported as a string (esbuild `loader: { '.css': 'text' }`). */
declare module '*.css' {
  const content: string;
  export default content;
}

/** Injected by the VS Code webview host. Absent in a plain browser. */
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
