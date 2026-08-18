import React, { useState } from 'react';
import { requestGroups } from '../util';
import type { Collection } from '../types.ts';

// A collection's requests as <option>s, grouped by the folder they live in.
// Shared with the picker on a step that is already in the flow.
interface RequestOptionsProps {
  collections: Collection[];
  collectionId: string | null | undefined;
}

export function RequestOptions({ collections, collectionId }: RequestOptionsProps) {
  return requestGroups(collections, collectionId).map(([path, list]) => {
    const options = list.map((r) => (
      // A shell test wears SH where a request wears its method — the same tag
      // the sidebar gives it, so the picker reads as the tree does.
      <option key={r.id} value={r.id}>
        {r.kind === 'shell' ? 'SH' : r.method} {r.name || (r.kind === 'shell' ? r.command : r.url)}
      </option>
    ));
    // Requests sitting at the collection root have no folder to label them
    // with, so they go in loose at the top.
    return path
      ? <optgroup key={path} label={path}>{options}</optgroup>
      : <React.Fragment key="__root">{options}</React.Fragment>;
  });
}

// Naming a step is the whole of adding one. What it runs is settled on the step
// itself, where the pencil opens the same dialog that edits everything else
// about it — asking twice, in two different shapes, only made the quick job
// (drop in the next step and get on with the flow) as long as the slow one.
interface AddStepModalProps {
  onAdd: (step: { name: string }) => void;
  onCancel: () => void;
}

export default function AddStepModal({ onAdd, onCancel }: AddStepModalProps) {
  const [name, setName] = useState('');
  const ready = !!name.trim();

  function submit() {
    if (ready) onAdd({ name: name.trim() });
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Add step</h3>

        <label className="field-label">Step name</label>
        <input
          className="modal-name"
          value={name}
          autoFocus
          placeholder="What this step proves"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="btn-send"
            disabled={!ready}
            title={ready ? '' : 'Give the step a name first'}
            onClick={submit}
          >Add step</button>
        </div>
      </div>
    </div>
  );
}
