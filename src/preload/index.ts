import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, HistorySnapshot, InkNestAPI, Result } from '../shared/contracts'

const api: InkNestAPI = Object.freeze<InkNestAPI>({
  createDocument: () => ipcRenderer.invoke('document:create'),
  openDocumentLink: request => ipcRenderer.invoke('document:link', request),
  getTheme: () => ipcRenderer.invoke('settings:theme'),
  setTheme: theme => ipcRenderer.invoke('settings:set-theme', theme),
  setPresentation: request => ipcRenderer.invoke('window:presentation', request),
  checkpoint: snapshot => ipcRenderer.invoke('backup:checkpoint', snapshot),
  listRecovery: () => ipcRenderer.invoke('backup:list-recovery'),
  inspectRecovery: id => ipcRenderer.invoke('backup:inspect-recovery', id),
  restoreRecovery: id => ipcRenderer.invoke('backup:restore-recovery', id),
  discardRecovery: id => ipcRenderer.invoke('backup:discard-recovery', id),
  listHistory: ref => ipcRenderer.invoke('backup:list-history', ref),
  inspectHistory: (ref, id): Promise<Result<HistorySnapshot>> => ipcRenderer.invoke('backup:inspect-history', ref, id),
  restoreHistory: request => ipcRenderer.invoke('backup:restore-history', request),
  exportHistory: (ref, id) => ipcRenderer.invoke('backup:export-history', ref, id),
  clearRecords: kind => ipcRenderer.invoke('backup:clear', kind),
  saveAs: request => ipcRenderer.invoke('document:save-as', request),
  reconcileExternal: state => ipcRenderer.invoke('document:reconcile', state),
  resolveConflict: (ref, action, snapshot) => ipcRenderer.invoke('document:conflict', ref, action, snapshot),
  save: (request) => ipcRenderer.invoke('document:save', request),
  openFile: () => ipcRenderer.invoke('document:open'),
  rendererReady: () => ipcRenderer.invoke('document:renderer-ready'),
  closeDocument: ref => ipcRenderer.invoke('document:close', ref),
  activateDocument: (ref) => ipcRenderer.invoke('document:activate', ref),
  completeClose: (requestId, state) => ipcRenderer.invoke('document:complete-close', requestId, state),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AppEvent): void => listener(event)
    ipcRenderer.on('document:event', handler)
    return () => ipcRenderer.removeListener('document:event', handler)
  },
  resolveResources: (ref, refs) => ipcRenderer.invoke('document:resources', ref, refs)
})
contextBridge.exposeInMainWorld('inknest', api)
