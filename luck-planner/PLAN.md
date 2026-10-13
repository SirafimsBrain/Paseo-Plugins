# luck-planner — план разработки (атомарные этапы)

> **Статус: версия в разработке (`0.5.0`).** Разработка приостановлена после этапа **B4**
> (FTS5-поиск и фильтры — выполнен, тесты зелёные). Следующий этап — **C1** (пчёлы, bees).
> Этапы A1–B4 закрыты и помечены ниже; блоки C–J не начинались. Подробности — в
> [`__doc.md`](./__doc.md) (источник истины).

План основан на:
- `Структура данных для плагина.txt` — доменная модель (дерево, листья, пчёлы, жуки, высокие цели, темпы роста);
- `TEMP-ARCHITECTURE-RESEARCH.md` — результаты исследования по MetaGPT/Plandex/Memory Bank/OpenHands (переносятся в `__doc.md`, файл удаляется);
- `Для создания интерактивного dashboard.md` (2D) и `...dashboard 3D.md` (3D);
- ограничений Paseo Plugin SDK 0.11 (текущий демон 0.11.2) и прецедентов репозитория: memory-flash (SQLite/FTS5, stdio MCP, HTTP-сервер, инъекция в агентов), bunny-search (открытие веб-UI в workspace browser).

Принцип: **точность и качество важнее скорости**. Каждый этап — один независимый коммит, который заканчивается зелёными `npm run typecheck` и `vitest run`, и по нему можно продолжать работу следующего агента без потери контекста. Версия плагина и git-тег — по правилам `AGENTS.md` (minor-бамп за новую функциональность, тег `<имя>@<версия>` в origin).

---

## 1. Ключевые архитектурные решения (ADR)

| # | Решение | Обоснование |
|---|---------|-------------|
| **ADR-1** | **Дашборд (2D и 3D) — отдельное веб-приложение (React + TypeScript), отдаваемое HTTP-сервером плагина на `127.0.0.1` и открываемое в workspace browser Paseo** (`navigation.openBrowser`), с фолбэком на `openExternalUrl`. Нативная RN-панель — обзорный слой, работающий везде (включая мобильные клиенты). | Клиентский код плагина — React Native: DOM, canvas, WebGL, `react-native-svg`, DOM-библиотеки **запрещены** (reference.md → Cross-platform rules; tsconfig без DOM). React Flow / Cytoscape / Three.js физически нельзя вставить в панель. Прецеденты в этом же репо: bunny-search открывает своё веб-UI в табе Paseo; memory-flash держит HTTP-сервер в daemon-процессе. Workspace browser — Electron Chromium → WebGL доступен для 3D. |
| **ADR-2** | **Хранилище — один SQLite-файл** `$PASEO_HOME/plugins/luck-planner/luck-planner.db` (node:sqlite, Node ≥ 24.20), WAL, `busy_timeout` 5 s + write-retry, FTS5 (porter unicode61), таблица `meta.schema_version` + миграции. Все записи скоупятся через `project_key` (канонический путь workspace/проекта). | Прямое требование заказчика («в качестве хранилища использовать SQLite», «FTS5 и усиление поиска, пример — memory-flash»). Один файл с `project_key` проще, чем файл на проект, и повторяет проверенную схему memory-flash. Урок memory-flash 0.3.2 (параллельные писатели: busy timeout + retry) переносится сразу, не по факту потери записи. |
| **ADR-3** | **Доступ агентов — bundled stdio MCP-сервер** (`dist/mcp-server.js`, esbuild), инъекция в каждого агента через `server.before("agent.create")` + `paseo-plugin.json` `mcp.entry` (revision-independent публикация, как в memory-flash 0.7.x). Агенты читают/пишут дерево инструментами `luck_tree_*`. | Цель плагина — чтобы агенты кодирования вели дерево фактов. RPC плагина недоступен агентам напрямую; MCP — единственный канал. Проверенная механика memory-flash/bunny-search. |
| **ADR-4** | **2D — React Flow** (кастомные ноды, рёбра, зум/пан, fitView). **3D — @react-three/fiber + drei + d3-hierarchy** (последний блок этапов). Оба вида дашборда живут на **общем слое данных** (один и тот же JSON API + адаптер graph-модели + общая панель деталей), переключатель 2D/3D в toolbar. | Соответствует обоим заказным документам: 2D-doc рекомендует React Flow, 3D-doc — react-three-fiber для метафоры «ствол/ветки/листья/пчёлы». Общий data-слой исключает расхождение логики между видами и делает 3D чистой подменой рендерера. |
| **ADR-5** | **Дерево в SQLite — adjacency list** (`parent_id`) + kind-enum (`root\|trunk\|branch\|subbranch\|leaf`), без materialized path. Для раскладки дашборда дерево собирается в памяти одним запросом. | Гибкое перемещение узлов без пересчёта путей; объём данных (тысячи узлов) не требует materialized path; раскладка — на стороне дашборда. |
| **ADR-6** | **Листья — конечный автомат статусов** из заказной структуры: `draft → ready → claimed → in_progress → (blocked) → done`, плюс терминальные `cancelled / superseded`. Каждый переход инкрементирует `revision` и пишет append-only аудит (`кто, когда, что, с каким результатом` — обязательное требование заказчика). | Машина состояний + ревизии — сердце «план/факт». Аудит пишется с первого же CRUD-этапа (B3), потом только читается. |
| **ADR-7** | **Высокие цели имеют approval gate**: `draft → proposed → approved` (утверждает человек через нативную панель; при оркестрации/субагентах — управляющий агент). Только `approved` материализуется в под-ветки с листьями. | Требование заказчика: «в Дерево проекта попадают только после утверждения согласованного плана». Прецедент Plandex review gate из TEMP-дока. |
| **ADR-8** | **Dashboard v1 — read-only**. Все мутации (статусы листьев, цели) — через MCP (агенты) или нативную панель (человек). Редактирование прямо из дашборда — roadmap. | Сужает поверхностную атаку HTTP-слоя и сохраняет чистоту первого релиза; API и так нужен только на чтение. |
| **ADR-9** | HTTP-сервер: только `127.0.0.1`, пер-инсталляционный токен доступа в URL (прецедент API-ключей memory-flash), `GET /health`, отдача SPA из `dist/dashboard`. Никакой привязки на `0.0.0.0` без явной настройки. | Плагин — доверенный код с доступом к машине; не расширяем attack surface дешёвым биндингом. |

## 2. Целевая структура каталогов

```text
luck-planner/
├── paseo-plugin.json        # id, requirements >=0.11.0, build: [[npm,ci],[npm,run,bundle]], mcp.entry
├── package.json             # scripts: bundle (mcp + dashboard), typecheck, test
├── tsconfig.json            # + vitest.config.mts
├── index.client.tsx         # панель, ⌘K-пункты, slash-команды, «Открыть дашборд», settings screen
├── index.server.ts          # RPC handlers, before/on hooks, жизненный цикл HTTP-сервера, MCP-инъекция
├── shared/                  # zod-контракты, без Node/React
│   ├── tree.ts              # узлы, kind, статусы, ревизии
│   ├── links.ts             # пчёлы и жуки
│   ├── goals.ts             # высокие цели: формальное описание + план
│   ├── growth.ts            # темпы роста (goal → шаги → факты)
│   ├── rpc.ts               # defineRpc-контракты
│   └── tools.ts             # схемы MCP-инструментов
├── server/
│   ├── store.ts             # SQLite: схема v1, миграции, CRUD, FTS5, аудит
│   ├── semantics/           # state-machine, bees, bugs, goals, growth (по файлу на домен)
│   ├── mcp-server.ts        # stdio JSON-RPC 2.0
│   ├── mcp-tools.ts         # транспорт-независимый dispatch
│   ├── mcp-launch.ts        # резолв node + entry, публикация revision-independent пути
│   ├── http-server.ts       # SPA + JSON API + SSE + health
│   └── skill.ts             # SKILL.md для агентов + установщик
├── client/
│   ├── tree-panel.tsx       # нативная workspace-панель (дерево-аутлайн)
│   ├── details.tsx          # панель деталей узла
│   ├── open-dashboard.ts    # openBrowser → фолбэк openExternalUrl
│   └── use-host-typography.ts
├── dashboard/               # веб-приложение (отдельный бандл, НЕ импортируется из client/server)
│   ├── index.html
│   └── src/                 # app, data-адаптер, layout, nodes2d/, scene3d/, details/
├── scripts/bundle.mjs       # esbuild: dist/mcp-server.js + dist/dashboard/*
├── tests/                   # vitest: store, semantics, mcp e2e, http, adapters
├── README.md                # English (по правилам проекта)
└── __doc.md                 # English, техническое описание
```

Импорт-границы SDK строгие: `dashboard/` не импортируется ни из `client/`, ни из `server/` — он собирается esbuild'ом отдельным entry и только раздаётся HTTP-сервером (прецедент `dist/mcp-server.js` в memory-flash).

## 3. Модель данных (схема v1, эскиз)

```sql
-- Узлы дерева: корень(техстек) → ствол → основные ветки → побочные ветки → листья(факты)
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,             -- uuid
  project_key TEXT NOT NULL,       -- канонический путь проекта
  parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('root','trunk','branch','subbranch','leaf')),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL,            -- для leaf: draft|ready|claimed|in_progress|blocked|done|cancelled|superseded
  version TEXT DEFAULT '',         -- версия факта/кода
  revision INTEGER NOT NULL DEFAULT 1,
  payload TEXT DEFAULT '{}',       -- JSON: tech-стек корня, file/function у веток, plan/fact у листа
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT,  -- agent id | 'user'
  archived_at INTEGER
);
CREATE INDEX nodes_project_parent ON nodes(project_key, parent_id);

-- Пчёлы: связи между листьями (влияние), статус + ревизия описывают влияние
CREATE TABLE bees (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  source_leaf_id TEXT NOT NULL REFERENCES nodes(id),
  target_leaf_id TEXT NOT NULL REFERENCES nodes(id),
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  impact TEXT DEFAULT '',          -- степень/описание влияния
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);

-- Жуки: проблемы/инциденты, мешающие листу(ям)
CREATE TABLE bugs (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT DEFAULT '',
  severity TEXT NOT NULL,          -- low|medium|high|critical
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);
CREATE TABLE bug_nodes (bug_id TEXT REFERENCES bugs(id), node_id TEXT REFERENCES nodes(id),
  PRIMARY KEY (bug_id, node_id));  -- жук может влиять на группу листьев

-- Высокие цели: формальное описание + разобранный план; approval gate
CREATE TABLE goals (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  formal_text TEXT NOT NULL,       -- задание на естественном языке
  plan_json TEXT NOT NULL,         -- план агента: атомарные шаги
  status TEXT NOT NULL,            -- draft|proposed|approved|in_progress|done|cancelled
  materialized_node_id TEXT REFERENCES nodes(id),  -- поддерево, выращенное после approve
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);

-- Темпы роста: goal → шаги → факты; присваиваются ЛЮБОМУ элементу дерева
CREATE TABLE growth (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('node','goal')),
  subject_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,        -- [{step, state, facts[], reason}]
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);

-- Append-only аудит: кто/когда/что/результат (обязательное требование)
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- create|update|status|link|approve|...
  revision INTEGER NOT NULL, actor TEXT,
  result TEXT DEFAULT '', at INTEGER NOT NULL
);

CREATE TABLE node_fts USING fts5(name, description, payload, content='nodes', content_rowid='rowid',
  tokenize='porter unicode61');   -- + триггеры INSERT/UPDATE/DELETE (шаблон memory-flash)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version
```

Статусы листа ровно как в заказной структуре. `history` заполняется с этапа B3 — без исключений.

## 4. Атомарные этапы

Каждый этап: `npm run typecheck` + `vitest run` зелёные, minor-бамп версии, анонсированный тег `<luck-planner>@<версия>` в origin (по `AGENTS.md`). Этапы блоков B–D можно делегировать разным агентам: границы — файлы, конфликты исключены.

### Блок A — Каркас и фиксация архитектуры

**A1. Каркас плагина** → `0.1.0`
- `paseo plugin init` (или вручную по конвенциям репо): `paseo-plugin.json` (`id: luck-planner`, `requirements: {paseo: ">=0.11.0"}`), `package.json` (devDeps: `@getpaseo/plugin@0.11.2`, `zod`, `react`, `react-native`, `vitest`, `esbuild`, `typescript`), `tsconfig.json`, `vitest.config.mts`.
- Пустые `index.client.tsx` / `index.server.ts`, дефолтный экспорт возвращает cleanup.
- Приёмка: typecheck/tests зелёные; `paseo plugin install <путь>` → `paseo plugin ls` показывает `running`, `paseo plugin logs luck-planner` без ошибок.

**A2. `__doc.md` v1 + приборка TEMP** (документация, без бампа)
- Перенести в `__doc.md` (English) стойкие решения TEMP-дока: DAG-модель задач и каскадный reset (MetaGPT), approval gate (Plandex), append-only event log + schema versioning (OpenHands), план/факт как «ожидание vs. подтверждённый факт» (Memory Bank). Зафиксировать ADR-1…ADR-9 выше, эскиз схемы, целевую структуру.
- Удалить `TEMP-ARCHITECTURE-RESEARCH.md` (его собственный регламент: удалить при старте кода).
- Приёмка: `__doc.md` самодостаточен — следующий агент строит блок B только по нему.

### Блок B — Хранилище

**B1. Доменные zod-схемы в `shared/`** → `0.2.0` ✅
- `tree.ts`, `links.ts`, `goals.ts`, `growth.ts`: enum-ы kind/status/severity, типы узлов, ревизий, аудита. Один источник правды для server, MCP и RPC.
- Приёмка: типы импортируются из обоих рантаймов (проверка импорт-границ), юнит-тесты валидации переходов статусов (таблица разрешённых переходов).

**B2. `server/store.ts`: схема SQLite v1** → `0.3.0` ✅
- `node:sqlite`, путь `$PASEO_HOME/plugins/luck-planner/luck-planner.db`, WAL + `synchronous=NORMAL`, `busy_timeout` 5 s + write-retry (перенос паттерна memory-flash 0.3.2), `meta.schema_version` + каркас миграций, `project_key`-скоуп.
- Приёмка: тесты на реальном файле БД во временной директории: создание схемы, повторный open (идемпотентность), конкурентные записи (2 потока пишут без потерь), миграционный путь v0→v1.

**B3. CRUD узлов + state machine + ревизии + аудит** → `0.4.0` ✅
- `createNode / moveNode / archiveNode / setStatus(leaf)`; запрет недопустимых переходов статуса; инкремент `revision` на каждое изменение; запись в `history` (`actor`, `action`, `revision`, `result`, `at`) на **каждую** мутацию.
- Приёмка: тесты — валидный/невалидный переход, ревизия растёт, история непротиворечива, каскад архивации поддерева.

**B4. FTS5-поиск и фильтры** → `0.5.0` ✅
- Триггеры синхронизации `node_fts`, `search(query, {kind, status, project})` c `key=value`-фильтрами и OR-токенизацией (перенос `parseQuery`/`ftsQuery`-подхода memory-flash), fallback LIKE для пустого индексируемого текста.
- Приёмка: тесты на включение/исключение/порядок bm25; выражения MATCH проходят валидацию SQLite; поиск по кириллице работает.

### Блок C — Семантика домена

**C1. Пчёлы (bees)** → `0.6.0`
- CRUD связей: оба конца — листья одного `project_key`, запрет петель, `status/revision/impact`, аудит. API «все пчёлы узла» (в обе стороны) — нужен дашборду и панели.
- Приёмка: тесты валидации концов/петель, ревизия связи, «влияние на группу» через набор bees.

**C2. Жуки (bugs)** → `0.7.0`
- CRUD инцидентов + m2m `bug_nodes` (жуки влияют на лист или группу листьев), severity, status/revision, аудит. Правило: жук со status `open` на листе виден в деталях листа как блокер.
- Приёмка: тесты привязки к нескольким листьям, отвязки, «открытые жуки листа».

**C3. Высокие цели (goals) + approval gate** → `0.8.0`
- `draft → proposed → approved` (утверждение — только через нативную панель/RPC с пометкой актора `user` или управляющего агента), `approved` материализует поддерево (побочные ветки + листья из `plan_json`) через `materialized_node_id`; `superseded` при замене плана с каскадным reset затронутых листей (урок MetaGPT `reset_task`).
- Приёмка: тесты — неутверждённая цель не в дереве; материализация идемпотентна; смена плана гасит производные листья.

**C4. Темпы роста (growth)** → `0.9.0`
- Полиморфная привязка (`node` | `goal`), `steps_json` = goal→шаги→факты выполнения/невыполнения + причины остановок/согласований, status/revision, аудит. Read API «прогресс по цели/узлу» — агрегат для дашборда.
- Приёмка: тесты привязки к узлу и к цели, агрегация прогресса (доля выполненных шагов), ревизия.

### Блок D — Доступ агентов (MCP)

**D1. Tool-контракты + dispatch** → `0.10.0`
- `shared/tools.ts` (zod) + `server/mcp-tools.ts` (транспорт-независимый): `luck_tree_get_context` (путь корень→…→лист + соседние факты — «агент спускается на уровень ствола»), `luck_tree_search`, `luck_tree_upsert_leaf` (план/факт + версия), `luck_tree_add_bee`, `luck_tree_report_bug`, `luck_tree_set_goal` (только draft/proposed), `luck_tree_update_growth`, `luck_tree_history`.
- Приёмка: диспатч-тесты на каждый инструмент (валидация входа, понятные тексты ошибок), ничего не пишет мимо `project_key`.

**D2. stdio MCP-сервер + бандл** → `0.11.0`
- `server/mcp-server.ts` (JSON-RPC 2.0, `initialize`/`tools/list`/`tools/call`, stdout только для протокола), `scripts/bundle.mjs` (esbuild → `dist/mcp-server.js` на Node builtins), `build` в `paseo-plugin.json` (строго `string[][]`!), `mcp.entry`; публикация entry по revision-independent пути (перенос урока memory-flash 0.7.1: ревизионный uuid каталог удаляется при update).
- Приёмка: e2e-тест реального спавна `dist/mcp-server.js` + `initialize` handshake + `tools/call`; повторный `npm run bundle` детерминирован.

**D3. Инъекция в агентов + настройки + SKILL.md** → `0.12.0`
- `server.before("agent.create")`: `config.mcpServers["luck-planner"] = {type:"stdio", command, args}` (резолв реального node-бинаря, как memory-flash `resolveNodeCommand`), настройки `injectIntoAgents`, `mcpServerName`. `server/skill.ts`: SKILL.md (как вести дерево: когда создавать лист, когда переводить статус, что писать в revision/аудит) + установщик в каталоги скиллов агентов.
- Приёмка: `paseo plugin logs` подтверждает инъекцию; агент в реальной сессии вызывает `luck_tree_search` и создаёт лист; скилл устанавливается.

### Блок E — Нативный UI в Paseo

**E1. RPC-контракты + server handlers** → `0.13.0`
- `shared/rpc.ts` (`defineRpc`): `tree.get`, `tree.search`, `node.detail` (+история, пчёлы, жуки), `node.setStatus`, `goal.approve`, `growth.get`, `stats`. Валидация на обеих сторонах; ошибки — читаемые `{ok, error}`.
- Приёмка: хендлер-тесты; ни один RPC не пишет без `project_key`; `goal.approve` фиксирует актора.

**E2. Нативная workspace-панель** → `0.14.0`
- `client/tree-panel.tsx`: сворачиваемый дерево-аутлайн (корень→…→листья), цветовой индикатор статуса листа, счётчики (всего/в работе/готово/открытые жуки), клик по листу → детали (версия, ревизия, статус, пчёлы, жуки, история), фильтры по статусу/типу, поиск (FTS). Всё из `theme.colors`, `layout.compact`, типографика хоста (`use-host-typography` по образцу memory-flash).
- Приёмка: ручная проверка в светлой/тёмной теме и compact-режиме; аудит-grep `rg -n "document\.|window\.|className=|onClick=" client/` — ноль совпадений.

**E3. Command Center + slash-команды** → `0.15.0`
- ⌘K: «Open luck-planner tree», «New high goal», «Open dashboard». Slash: `/luck-status <leaf> <status>`, `/luck-bug <title>` — быстрые записи из композера.
- Приёмка: пункты находятся в ⌘K, slash-команда пишет через RPC и попадает в историю.

**E4. Settings screen** → `0.16.0`
- `defineSettings`: `injectIntoAgents`, `mcpServerName`, порт HTTP-сервера (default + auto), токен доступа (перегенерация), retention истории.
- Приёмка: значения сохраняются между рестартами даэмона; изменение `injectIntoAgents` не требует перезапуска демона (только reload плагина).

### Блок F — HTTP-транспорт дашборда

**F1. `server/http-server.ts`** → `0.17.0`
- Старт в жизненном цикле плагина (или по первому запросу), `127.0.0.1`, порт из настроек (auto-fallback на эфемерный), пер-инсталляционный токен. Эндпоинты (read-only): `GET /health`, `GET /api/tree?project=` (узлы+пчёлы+жуки+цели+рост одним ответом — готовый graph для раскладки), `GET /api/node/:id` (детали+история+связи), `GET /api/search`, `GET /api/stats`, `SSE /api/events` (заготовка для H1). Отдача SPA из `dist/dashboard` (index.html + asset'ы, correct content-type).
- Приёмка: тесты на реальном сервере (прецедент `tests/http-server.test.ts` в memory-flash): health, 401 без токена, JSON-ответы согласованы с shared-схемами, SPA отдаётся, cleanup останавливает сервер (нет утечки порта).

**F2. «Открыть дашборд»** → `0.18.0`
- `client/open-dashboard.ts`: `navigation.openBrowser({url с токеном, workspaceId})` на Electron; фолбэк `openExternalUrl` (прецедент bunny-search `open-search-ui.ts`). Кнопка в панели + пункт ⌘K.
- Приёмка: на desktop дашборд открывается в табе Paseo; при отсутствии workspace/на не-Electron — внешний браузер.

### Блок G — Dashboard 2D: диаграмма (React Flow)

**G1. Каркас веб-приложения** → `0.19.0`
- `dashboard/`: React+TS, layout — toolbar (поиск, фильтры, переключатель 2D/3D-заглушка), canvas, details-panel, legend. Сборка esbuild → `dist/dashboard` (отдельный entry; ленивая подгрузка не нужна — пока только 2D).
- Приёмка: страница открывается через F2, консоль браузера без ошибок, стили не завязаны на тему Paseo (собственная тёмная/светлая тема дашборда).

**G2. Данные + раскладка** → `0.20.0`
- Data-адаптер `/api/tree` → React Flow nodes/edges (чистые функции, покрыты vitest без DOM): маппинг kind/status → тип узла, раскладка d3-hierarchy (radial или layered) + авто-зазоры, `collapse/expand` веток, корень-техстек и ствол выделяются формой.
- Приёмка: адаптер-тесты (дерево из фикстур → ожидаемые positions/типы); на синтетике в 1000 узлов с collapse по умолчанию canvas остаётся отзывчивым.

**G3. Кастомные ноды и рёбра** → `0.21.0`
- Узлы: корень ⚙️, ствол, ветка 📦, лист с полосой статуса (план/в работе/готово) + `v{version} · r{revision}`; жуки 🐞 как ноды-бейджи на листах; цели 🎯 как групповые рамки под-деревьев. Рёбра-пчёлы 🐝 с типом/статусом.
- Приёмка: визуальная сверка на фикстурах; статус читается цветом И текстом (не только цветом).

**G4. Интерактив** → `0.22.0`
- Клик по узлу → details-panel (REST `/api/node/:id`: версия, ревизия, статус, пчёлы, жуки, история); подсветка всех связей выбранного узла (пчёлы + жуки); поиск с фокусом камеры на узле; фильтры по типу/статусу/версии; зум/пан/fitView.
- Приёмка: ручной сценарий — найти лист поиском, увидеть его блокеры и всё, чем он связан, без скролла-охоты.

**G5. Темпы роста на диаграмме** → `0.23.0`
- Слой прогресса: прогресс-бар внутри узла цели/узла + режим тепловой карты по всему дереву (доля выполненных шагов growth).
- Приёмка: фикстура с тремя целями (0 %, 50 %, 100 %) различима визуально; переключение слоя не ломает раскладку.

### Блок H — Живые данные

**H1. SSE + инвалидация кэша** → `0.24.0`
- `/api/events`: событие `tree-changed` после любой записи (store → event bus → SSE); дашборд слушает и делает refetch изменённого поддерева. В нативной панели — инвалидация TanStack Query по тем же событиям (RPC-опрос или подписка).
- Приёмка: e2e-сценарий — статус листа меняется MCP-инструментом, дашборд и панель обновляются без ручного refresh.

**H2. Timeline-строки агента** *(опционально)* → `0.25.0`
- `paseo.agents.ref(id).timeline.append` о ключевых фактах (цель утверждена, лист доведён до done) с рендерером plugin-item; данные ≤ 64 KiB.
- Приёмка: строка видна в таймлайне агента, рендерер зарегистрирован (нет «unavailable»).

### Блок I — Dashboard 3D: дерево (**последний блок**, только после зелёного G+H)

**I1. Спайк WebGL + фиксация библиотеки** → `0.26.0`
- Проверить WebGL в workspace browser (Electron) и во внешнем браузере на целевых клиентах; зафиксировать в `__doc.md`: `@react-three/fiber` + `drei` + `d3-hierarchy`; фолбэк-поведение при отсутствии WebGL (показать 2D + пояснение). Ленивый entry `dashboard-3d.js` (загружается только при переключении — не раздувать первый чанк).
- Приёмка: пустая сцена с OrbitControls рендерится в табе Paseo; фолбэк срабатывает при `--disable-webgl`.

**I2. 3D-дерево: раскладка + геометрия** → `0.27.0`
- Та же graph-модель → 3D: depth → высота, x/z — радиальное расположение; корень — сфера с техстеком, ствол — цилиндры, ветки — трубы (толщина по числу листьев), листья — спрайты с цветом статуса.
- Приёмка: дерево фикстур читается как дерево (видна иерархия без кликов); инстансинг листьев, бюджет — плавные 5–10 тыс. узлов.

**I3. Пчёлы, жуки, цели, рост в 3D** → `0.28.0`
- Пчёлы — анимированные частицы, летящие по рёбрам (статус/ревизия в тултипе); жуки — пульсирующие красные узлы на листьях; цели — парящие кольца/сферы над под-деревьями; темпы роста — свечение/прогресс-кольца.
- Приёмка: каждый тип связей различим на глаз; анимация не деградирует FPS на 1000 узлов (замер).

**I4. Интерактивность 3D + переключатель 2D/3D** → `0.29.0`
- OrbitControls, raycaster-клик → **та же** details-panel (общий компонент с 2D), Html-подписи (drei) для фокусного узла, фокус камеры из поиска, фильтры по типу/статусу/версии; переключатель 2D/3D в toolbar (состояние в URL/localStorage); LOD/инстансинг по результатам замеров I2–I3.
- Приёмка: сценарий «найти лист → клик → детали → подсветка связей» идентичен в 2D и 3D; переключение сохраняет выбранный узел.

### Блок J — Финализация (без бампа версии)

**J1. README.md (English) + ссылка в главный README**
- README плагина: что делает, установка, MCP-инструменты, дашборд 2D/3D, настройки; ссылка добавляется в корневой `README.md` в секцию Plugins (по правилам `AGENTS.md`).
- Приёмка: `README.md` и `__doc.md` полностью на английском; ссылка из корневого README рабочая.

**J2. Приёмочная e2e-проверка на живом даэмоне + финальный `__doc.md`**
- Чек-лист: установка из git-источника (`paseo plugin add ...:luck-planner`), `running` без ошибок; агент через MCP создаёт/обновляет лист; человек утверждает цель из панели; дашборд открывается в табе Paseo; 2D и 3D проходят сценарий G4/I4; SSE обновляет оба вида; тёмная/светлая тема, compact; `paseo plugin logs` чистый. Замеры (узлы, FPS, размер бандла) — в `__doc.md`.
- Приёмка: всё из чек-листа подтверждено и записано; известные ограничения перечислены явно.

## 5. Порядок версий и тегов

| Этап | Версия | Этап | Версия |
|------|--------|------|--------|
| A1 | 0.1.0 | E1–E4 | 0.13.0–0.16.0 |
| B1–B4 | 0.2.0–0.5.0 | F1–F2 | 0.17.0–0.18.0 |
| C1–C4 | 0.6.0–0.9.0 | G1–G5 | 0.19.0–0.23.0 |
| D1–D3 | 0.10.0–0.12.0 | H1–H2 | 0.24.0–0.25.0 |
| | | I1–I4 | 0.26.0–0.29.0 |

Каждый бамп — анонсированный тег `luck-planner@<версия>` на коммите с этой версией, отправка в origin (правило проекта). Слово «release» в задаче не используется — major-бамп не планируется.

## 6. Риски и валидационные спайки

| Риск | Митигейция |
|------|-----------|
| WebGL недоступен в workspace browser на каком-то клиенте | Спайк I1 — до написания сцены; фолбэк на 2D с пояснением |
| React Flow проседает на >1000 узлов | Collapse/expand по умолчанию (G2), фильтры, замер на синтетике в приёмке G2 |
| 3D-бандл раздувает первый чанк | Отдельный lazy-entry `dashboard-3d.js` (I1), загрузка только по переключателю |
| Конкурентный доступ к SQLite (агенты + UI + HTTP) | WAL + busy timeout + write-retry с этапа B2 (урок memory-flash 0.3.2), один процесс-владелец БД |
| Обновление плагина ломает MCP-путь агентов | Revision-independent публикация entry с этапа D2 (урок memory-flash 0.7.1) |
| HTTP-слой как вектор | 127.0.0.1 + токен + read-only API (ADR-8, ADR-9) |
| Мобильные клиенты без workspace browser | Нативная панель работает везде; дашборд — openExternalUrl; 3D на мобильном — best-effort, ограничение зафиксировано в README |

## 7. Правила для всех этапов

1. Один этап = один коммит; код пишется по `__doc.md`, а не по памяти.
2. Типы/контракты — только в `shared/` (zod), импорт-границы SDK соблюдаются (в т.ч. type-only импорты).
3. Каждый тест — на реальном артефакте (файловая БД, реальный spawn MCP, реальный HTTP-порт), как в memory-flash. Без моков там, где можно без них.
4. Ручная приёмка UI — обязательна (тема, compact, консоль браузера чистая), `npm run typecheck` + `vitest run` — зелёные до коммита.
5. `README.md` и `__doc.md` — только на английском (правила проекта); этот PLAN.md — рабочий документ на русском, как и соседние planning-файлы.
