import { useState } from 'react';
import { useAppStore } from '../../store/app';
import { newId } from '../../services/storage';
import type { PropAsset } from '../../types/model';
import { Field } from '../bits';
import { Icon } from '../Icon';

/**
 * 关键道具库（Phase 2 · 一等资产面板）
 *
 * 将跨多镜反复出现的关键道具（如玉佩、怀表、铁剑、密信）升级为独立资产，
 * 固定其不可变外观特征与归属角色，防止跨镜形状或材质漂移。
 */
export function PropsSection() {
  const project = useAppStore((s) => s.project);
  const patchProject = useAppStore((s) => s.patchProject);
  const [newName, setNewName] = useState('');

  if (!project) return null;
  const propsList = project.props ?? [];

  function saveList(next: PropAsset[]) {
    patchProject({ props: next });
  }

  function addProp() {
    const trimmed = newName.trim() || `关键道具 ${propsList.length + 1}`;
    const item: PropAsset = {
      id: newId('prop'),
      name: trimmed,
      canonicalTraits: '',
    };
    saveList([...propsList, item]);
    setNewName('');
  }

  function updateProp(id: string, patch: Partial<PropAsset>) {
    saveList(propsList.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeProp(id: string) {
    saveList(propsList.filter((item) => item.id !== id));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h2 className="card-title" style={{ marginBottom: 4 }}>
              关键道具库
              <span className="tag" style={{ marginLeft: 8 }}>
                {propsList.length} 件
              </span>
            </h2>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              把跨多镜反复出现的关键道具（如信物、武器、工具）固定外观特征，并在分镜中引用，避免换镜变形。
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="text"
              aria-label="新道具名称"
              style={{ maxWidth: 200 }}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例：裂纹铜怀表"
              onKeyDown={(e) => {
                if (e.key === 'Enter') addProp();
              }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={addProp}>
              <Icon name="plus" size={14} />
              <span>新增道具</span>
            </button>
          </div>
        </div>
      </div>

      {propsList.length === 0 ? (
        <div className="empty">还没有关键道具。把影响剧情连贯的道具登记在这里，分镜即可直接绑定。</div>
      ) : (
        propsList.map((prop) => (
          <div className="card" key={prop.id}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <input
                type="text"
                aria-label="道具名称"
                style={{ maxWidth: 240 }}
                value={prop.name}
                onChange={(e) => updateProp(prop.id, { name: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`删除道具「${prop.name}」`}
                onClick={() => removeProp(prop.id)}
              >
                <Icon name="trash" size={14} />
                <span>删除</span>
              </button>
            </div>
            <div className="grid-2">
              <Field
                label="不可变外观特征（建议中英双语或英文短语）"
                hint="会自动注入引用该道具的镜头提示词"
              >
                <input
                  type="text"
                  aria-label={`${prop.name}的外观特征`}
                  value={prop.canonicalTraits}
                  onChange={(e) => updateProp(prop.id, { canonicalTraits: e.target.value })}
                  placeholder="例：antique brass pocket watch with hairline crack on glass"
                />
              </Field>
              <Field label="归属角色（可选）">
                <select
                  aria-label={`${prop.name}的归属角色`}
                  value={prop.ownerCharacterId ?? ''}
                  onChange={(e) => {
                    const owner = e.target.value;
                    if (owner) {
                      updateProp(prop.id, { ownerCharacterId: owner });
                    } else {
                      const { ownerCharacterId: _omit, ...rest } = prop;
                      void _omit;
                      saveList(propsList.map((item) => (item.id === prop.id ? rest : item)));
                    }
                  }}
                >
                  <option value="">（无特定归属）</option>
                  {project.characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
