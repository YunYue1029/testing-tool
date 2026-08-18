import React, { useState } from 'react';
import { folderPath, isShellTest } from '../util';
import type { Collection, SavedRequest } from '../types.ts';

const NEW = '__new__';
const ROOT = '__root__';

// "Save request" dialog: name the request and pick (or create) the collection
// (and optionally a folder) it belongs to. Picking a different collection or
// folder moves the request there.
interface SaveTarget {
  name: string;
  collectionId?: string | null;
  newCollectionName?: string;
  folderId?: string | null;
}

interface SaveRequestModalProps {
  request: SavedRequest;
  collections: Collection[];
  currentCollectionId: string | null;
  onSave: (target: SaveTarget) => void | Promise<void>;
  onCancel: () => void;
}

export default function SaveRequestModal({
  request, collections, currentCollectionId, onSave, onCancel,
}: SaveRequestModalProps) {
  const [name, setName] = useState(request.name || '');
  const [target, setTarget] = useState(
    currentCollectionId || (collections.length ? collections[0].id : NEW)
  );
  const [folder, setFolder] = useState(
    target === currentCollectionId ? (request.folderId || ROOT) : ROOT
  );
  const [newColName, setNewColName] = useState('New Collection');
  // A shell test is filed exactly like a request — same collections, same
  // folders — so only the words change.
  const what = isShellTest(request) ? 'shell test' : 'request';

  const targetCol = collections.find((c) => c.id === target);
  const folders = (targetCol && targetCol.folders) || [];

  function pickTarget(value: string) {
    setTarget(value);
    // Reset the folder choice to root whenever the collection changes.
    setFolder(value === currentCollectionId ? (request.folderId || ROOT) : ROOT);
  }

  async function submit() {
    await onSave({
      name: name.trim() || (isShellTest(request) ? 'Untitled Shell Test' : 'Untitled Request'),
      collectionId: target === NEW ? null : target,
      newCollectionName: target === NEW ? (newColName.trim() || 'New Collection') : undefined,
      folderId: target === NEW || folder === ROOT ? null : folder,
    });
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Save {what}</h3>
        <label className="field-label">{what.charAt(0).toUpperCase() + what.slice(1)} name</label>
        <input
          className="modal-name"
          value={name}
          placeholder={isShellTest(request)
            ? 'e.g. The user row landed, Migrations applied…'
            : 'e.g. Login, List users…'}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <label className="field-label">Collection</label>
        <select
          className="modal-name"
          value={target}
          onChange={(e) => pickTarget(e.target.value)}
        >
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.id === currentCollectionId ? ' (current)' : ''}
            </option>
          ))}
          <option value={NEW}>➕ New collection…</option>
        </select>
        {target === NEW && (
          <input
            className="modal-name"
            value={newColName}
            placeholder="Collection name"
            onChange={(e) => setNewColName(e.target.value)}
          />
        )}
        {target !== NEW && folders.length > 0 && (
          <>
            <label className="field-label">Folder</label>
            <select
              className="modal-name"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              <option value={ROOT}>(collection root)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{folderPath(folders, f.id)}</option>
              ))}
            </select>
          </>
        )}
        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-send" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}
