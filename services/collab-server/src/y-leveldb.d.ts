declare module 'y-leveldb' {
  import * as Y from 'yjs'

  export class LeveldbPersistence {
    constructor(dir: string)
    getYDoc(docName: string): Promise<Y.Doc>
    storeUpdate(docName: string, update: Uint8Array): Promise<void>
    clearDocument(docName: string): Promise<void>
    destroy(): Promise<void>
  }
}
