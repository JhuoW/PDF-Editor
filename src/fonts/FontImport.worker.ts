import { inspectFont } from './fontAsset';
self.onmessage = async (event: MessageEvent<{ data: ArrayBuffer; fileName: string }>) => {
  try {
    const asset = await inspectFont(event.data.data, event.data.fileName);
    self.postMessage({ asset }, { transfer: [asset.data] });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
