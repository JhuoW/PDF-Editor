const DB_NAME = 'pdf-editor-storage';
const DB_VERSION = 1;
const STORE_NAME = 'pdfs';
const CURRENT_PDF_KEY = 'current-pdf';

interface StoredPDF {
  id: string;
  data: ArrayBuffer;
  fileName: string;
  lastOpened: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export async function saveCurrentPDF(data: ArrayBuffer, fileName: string): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const storedPDF: StoredPDF = {
      id: CURRENT_PDF_KEY,
      data: data,
      fileName: fileName,
      lastOpened: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const request = store.put(storedPDF);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(new Error('Failed to save PDF'));
      };
    });
  } catch (error) {
    console.error('Error saving PDF to storage:', error);
  }
}

export async function loadCurrentPDF(): Promise<{ data: ArrayBuffer; fileName: string } | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.get(CURRENT_PDF_KEY);
      request.onsuccess = () => {
        db.close();
        const result = request.result as StoredPDF | undefined;
        if (result) {
          resolve({ data: result.data, fileName: result.fileName });
        } else {
          resolve(null);
        }
      };
      request.onerror = () => {
        db.close();
        reject(new Error('Failed to load PDF'));
      };
    });
  } catch (error) {
    console.error('Error loading PDF from storage:', error);
    return null;
  }
}

export async function clearCurrentPDF(): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.delete(CURRENT_PDF_KEY);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(new Error('Failed to clear PDF'));
      };
    });
  } catch (error) {
    console.error('Error clearing PDF from storage:', error);
  }
}
