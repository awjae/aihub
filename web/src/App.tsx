import { useEffect, useMemo, useState } from 'react';

import AppRunner from './components/AppRunner';
import { fetchApps } from './lib/api';
import type { AppSummary } from './lib/types';

const UNGROUPED = '기타';

export default function App() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchApps()
      .then((list) => {
        if (cancelled) return;
        setApps(list);
        // URL 해시(#app-id)로 특정 앱에 바로 진입할 수 있게 한다.
        const fromHash = window.location.hash.slice(1);
        setSelectedId(list.some((a) => a.id === fromHash) ? fromHash : (list[0]?.id ?? null));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, AppSummary[]>();
    for (const app of apps) {
      const key = app.group ?? UNGROUPED;
      const bucket = map.get(key);
      if (bucket) bucket.push(app);
      else map.set(key, [app]);
    }
    return [...map.entries()];
  }, [apps]);

  const selected = apps.find((app) => app.id === selectedId) ?? null;

  const select = (id: string) => {
    setSelectedId(id);
    window.location.hash = id;
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <strong>AI Hub</strong>
            <small>사내 AI 도구 모음</small>
          </div>
        </div>

        {loading && <p className="sidebar-note">불러오는 중…</p>}

        {loadError && (
          <div className="error-box" role="alert">
            <strong>목록을 불러오지 못했습니다</strong>
            <p>{loadError}</p>
          </div>
        )}

        {!loading && !loadError && apps.length === 0 && (
          <p className="sidebar-note">
            등록된 앱이 없습니다. <code>config/apps.yaml</code> 에 앱을 추가해 주세요.
          </p>
        )}

        <nav>
          {grouped.map(([group, list]) => (
            <div className="nav-group" key={group}>
              <p className="nav-group-title">{group}</p>
              {list.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  className={`nav-item ${app.id === selectedId ? 'active' : ''}`}
                  onClick={() => select(app.id)}
                >
                  <span className="nav-item-icon">{app.icon ?? '●'}</span>
                  <span className="nav-item-body">
                    <span className="nav-item-name">{app.name}</span>
                    {app.description && (
                      <span className="nav-item-desc">{app.description}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="main">
        {selected ? (
          <AppRunner key={selected.id} app={selected} />
        ) : (
          !loading && <div className="empty-main">왼쪽에서 사용할 도구를 선택하세요.</div>
        )}
      </main>
    </div>
  );
}
