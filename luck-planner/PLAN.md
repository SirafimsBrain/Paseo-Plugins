# luck-planner — план разработки (атомарные этапы)

> **Статус: версия в разработке (`0.29.0`).** Этапы **E4** (settings screen +
> retention), **F1** (HTTP-сервер дашборда), **F2** («Открыть дашборд»), **G1**
> (каркас веб-приложения дашборда), **G2** (данные + раскладка), **G3**
> (кастомные ноды и рёбра), **G4** (интерактив), **G5** (темпы роста на
> диаграмме), **H1** (SSE + инвалидация кэша), **H2** (timeline-строки
> агента), **I1** (спайк WebGL + ленивый entry `dashboard-3d.js`), **I2**
> (3D-дерево: радиальная раскладка + геометрия), **I3** (пчёлы, жуки, цели и
> рост в 3D), **I4** (интерактивность 3D + переключатель 2D/3D), **J1**
> (README плагина на английском + ссылка из корневого README) и **J2**
> (приёмочная e2e-проверка на живом даэмоне: установка из git-источника,
> MCP-раунд-трип, утверждение цели, дашборд в табе хоста, сценарий G4/I4 в
> 2D и 3D, SSE, темы, консоль, замеры) выполнены, тесты зелёные.
> План исчерпан: кандидат **D4** (регистрация luck-planner в конфиг-файлах
> агентов OpenCode/Kilo/Cline/Cursor/Codex — по подходу memory-flash 0.8.0 +
> 0.8.2; сам memory-flash при этом не меняется, он уже содержит это решение)
> выполнен в `0.30.0` — новых этапов не запланировано.
> Этапы A1–I4, J1 и J2 закрыты (блоки E–I закрыты, блок J закрыт).
> Подробности — в [`__doc.md`](./__doc.md) (источник истины).

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
│   ├── api.ts               # read-only контракты dashboard HTTP API
│   └── tools.ts             # схемы MCP-инструментов
├── server/
│   ├── store.ts             # SQLite: схема v1, миграции, CRUD, FTS5, аудит
│   ├── semantics/           # state-machine, bees, bugs, goals, growth (по файлу на домен)
│   ├── mcp-server.ts        # stdio JSON-RPC 2.0
│   ├── mcp-tools.ts         # транспорт-независимый dispatch
│   ├── mcp-launch.ts        # резолв node + entry, публикация revision-independent пути
│   ├── http-server.ts       # SPA + JSON API + SSE + health
│   ├── http-lifecycle.ts    # жизненный цикл HTTP-сервера из настроек (debounce/restart)
│   └── skill.ts             # SKILL.md для агентов + установщик
├── client/
│   ├── tree-panel.tsx       # нативная workspace-панель (дерево-аутлайн)
│   ├── details.tsx          # панель деталей узла
│   ├── open-dashboard.ts    # openBrowser → фолбэк openExternalUrl (чистая логика)
│   ├── dashboard-screen.tsx # экран ⌘K «Open dashboard» + SDK-обвязка открытия
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

**C1. Пчёлы (bees)** → `0.6.0` ✅
- CRUD связей: оба конца — листья одного `project_key`, запрет петель, `status/revision/impact`, аудит. API «все пчёлы узла» (в обе стороны) — нужен дашборду и панели.
- Приёмка: тесты валидации концов/петель, ревизия связи, «влияние на группу» через набор bees.

**C2. Жуки (bugs)** → `0.7.0` ✅
- CRUD инцидентов + m2m `bug_nodes` (жуки влияют на лист или группу листьев), severity, status/revision, аудит. Правило: жук со status `open` на листе виден в деталях листа как блокер.
- Приёмка: тесты привязки к нескольким листьям, отвязки, «открытые жуки листа».

**C3. Высокие цели (goals) + approval gate** → `0.8.0` ✅
- `draft → proposed → approved` (утверждение — только через нативную панель/RPC с пометкой актора `user` или управляющего агента), `approved` материализует поддерево (побочные ветки + листья из `plan_json`) через `materialized_node_id`; `superseded` при замене плана с каскадным reset затронутых листей (урок MetaGPT `reset_task`).
- Приёмка: тесты — неутверждённая цель не в дереве; материализация идемпотентна; смена плана гасит производные листья.

**C4. Темпы роста (growth)** → `0.9.0` ✅
- Полиморфная привязка (`node` | `goal`), `steps_json` = goal→шаги→факты выполнения/невыполнения + причины остановок/согласований, status/revision, аудит. Read API «прогресс по цели/узлу» — агрегат для дашборда.
- Приёмка: тесты привязки к узлу и к цели, агрегация прогресса (доля выполненных шагов), ревизия.

### Блок D — Доступ агентов (MCP)

**D1. Tool-контракты + dispatch** → `0.10.0` ✅
- `shared/tools.ts` (zod) + `server/mcp-tools.ts` (транспорт-независимый): `luck_tree_get_context` (путь корень→…→лист + соседние факты — «агент спускается на уровень ствола»), `luck_tree_search`, `luck_tree_upsert_leaf` (план/факт + версия), `luck_tree_add_bee`, `luck_tree_report_bug`, `luck_tree_set_goal` (только draft/proposed), `luck_tree_update_growth`, `luck_tree_history`.
- Приёмка: диспатч-тесты на каждый инструмент (валидация входа, понятные тексты ошибок), ничего не пишет мимо `project_key`.

**D2. stdio MCP-сервер + бандл** → `0.11.0` ✅
- `server/mcp-server.ts` (JSON-RPC 2.0, `initialize`/`tools/list`/`tools/call`, stdout только для протокола), `scripts/bundle.mjs` (esbuild → `dist/mcp-server.js` на Node builtins), `build` в `paseo-plugin.json` (строго `string[][]`!), `mcp.entry`; публикация entry по revision-independent пути (перенос урока memory-flash 0.7.1: ревизионный uuid каталог удаляется при update).
- Приёмка: e2e-тест реального спавна `dist/mcp-server.js` + `initialize` handshake + `tools/call`; повторный `npm run bundle` детерминирован.

**D3. Инъекция в агентов + настройки + SKILL.md** → `0.12.0` ✅
- `server.before("agent.create")`: `config.mcpServers["luck-planner"] = {type:"stdio", command, args}` (резолв реального node-бинаря, как memory-flash `resolveNodeCommand`), настройки `injectIntoAgents`, `mcpServerName`. `server/skill.ts`: SKILL.md (как вести дерево: когда создавать лист, когда переводить статус, что писать в revision/аудит) + установщик в каталоги скиллов агентов.
- Приёмка: `paseo plugin logs` подтверждает инъекцию; агент в реальной сессии вызывает `luck_tree_search` и создаёт лист; скилл устанавливается.

**D4. Регистрация MCP-сервера в конфиг-файлах агентов** ✅ → `0.30.0`
- Регистрация `luck-planner` в **собственных конфиг-файлах агентов**: OpenCode (`~/.config/opencode/opencode.json|jsonc`, формат `mcp`), Kilo (`~/.config/kilo/kilo.jsonc|json`, тот же формат), Cline (`~/.cline/data/settings/cline_mcp_settings.json`, `mcpServers` + `transport`), Cursor (`~/.cursor/mcp.json`, `mcpServers` плоско), Codex CLI (`~/.codex/config.toml`, таблица `[mcp_servers.luck-planner]`). Кнопки в настройках плагина — по одной на агента и «для всех»; **ничего не пишется без явного запроса**: эти файлы меняют поведение всех сессий агента на машине, поэтому решение остаётся за человеком.
- Зачем: Paseo инъецирует сервер в *сессию* агента. OpenCode/Kilo держат сессионные регистрации в памяти per-directory и вытесняют простаивающий каталог — сервер и все его инструменты исчезают вместе с ним (`luck-planner_*` пропадают до конца жизни агента, хотя сам MCP-сервер здоров); Cline/Cursor/Codex CLI сессионные MCP-серверы вообще не подключают — для них запись в конфиге единственный путь. Запись в конфиг-файле переживает вытеснение (конфиг перечитывается при каждом старте локации). Второй, тонкий эффект (урок memory-flash): после вытеснения мёртвая сессионная запись всё ещё владеет именем `luck-planner` и **затеняет** живую конфиг-запись — поэтому при актуальной записи в конфиге сессионная инъекция **пропускается** (хук `agent.create`, с записью в лог), а инъекция остаётся запасным путём там, где конфиг записать нельзя.
- Правила записи: чужое содержимое сохраняется (другие ключи, серверы, таблицы, комментарии); файл, который не парсится как обычный JSON (комментарий `//`, синтаксическая ошибка), **не перезаписывается** — плагин сообщает о проблеме и оставляет файл как есть; запись атомарна (temp + rename) и сохраняет права файла; для TOML правится только своя таблица, остальное — байт в байт; пути считаются **на каждый вызов** (не на импорте), поэтому следуют за окружением.
- Приёмка ✅ (тестами): `tests/agent-mcp-config.test.ts` (22: формат каждого из пяти агентов; чужие ключи/серверы/таблицы/комментарии переживают и регистрацию, и удаление; сломанный файл не перезаписывается; повторная регистрация ничего не меняет, у Codex остаётся ровно одна своя таблица; статус правдив — зарегистрировано / зарегистрировано старой командой / не зарегистрировано / агента нет на машине; покрытие провайдера включает пропуск сессионной инъекции; запись атомарна — временных файлов не остаётся, права файла сохраняются; пути ведут туда, куда читает агент: XDG для OpenCode/Kilo, домашний каталог для Cline/Cursor/Codex). `tests/rpc.test.ts` — поверхность RPC дополнена тремя контрактами D4. `typecheck` (оба конфига) + `vitest run` зелёные (34 файла, 577 тестов).

### Блок E — Нативный UI в Paseo

**E1. RPC-контракты + server handlers** → `0.13.0` ✅
- `shared/rpc.ts` (`defineRpc`): `tree.get` (обзор: корни + дети первого уровня), `tree.search`, `node.detail` (+история, пчёлы, жуки, блокирующие, рост), `node.setStatus`, `goal.approve`, `growth.get` (+агрегат), `stats` (новый `store.stats()`). Валидация на обеих сторонах; записи — `{ok, error}`, актор `user` по умолчанию, один общий стор.
- Приёмка ✅: `tests/rpc.test.ts` (15 тестов, fake `PluginServerContext` + реальная БД); ни один RPC не пишет без `project_key`; `goal.approve` фиксирует актора.

**E2. Нативная workspace-панель** → `0.14.0` ✅
- `client/tree-panel.tsx` (`addWorkspacePanel`, `projectKey` = `projectRootPath` текущего workspace): сворачиваемый дерево-аутлайн (корень→дети), цветовой индикатор статуса листа + текст статуса, счётчики (`stats`: всего/в работе/готово/открытые жуки), клик по листу → детали (хлебные крошки, `v{version} · r{revision}`, статус, рост, блокирующие жуки, пчёлы, история) + смена статуса листа, фильтры по статусу/типу, поиск (FTS, debounce). Всё из `theme.colors`, `layout.compact`, шкала шрифта хоста (`client/use-host-typography.ts`). Чистая view-model — `shared/panel.ts`.
- Приёмка ✅: `tests/tree-panel.test.ts` (8 тестов на группировку/фильтры/метки без DOM); аудит-grep `document.|window.|className=|onClick=` по `client/` — ноль совпадений; ручная проверка темы/compact — за хостом (следующая живая проверка — на даэмоне в J2).

**E3. Command Center + slash-команды** → `0.15.0` ✅
- ⌘K (workspace-контекст): «Open luck-planner tree» (открывает панель), «New high goal» (через новый RPC `goal-create` создаёт draft-цель с placeholder-текстом и одним шагом — диалогового API в SDK 0.11 нет, план уточняется агентом; цель вне дерева до аппрува, ADR-7). Пункт «Open dashboard» перенесён в F2 — до HTTP-сервера он мёртвый. Slash (agent-контекст): `/luck-status <leaf|id> <status>` (uuid проходит напрямую, иначе FTS по листьям: 1 совпадение — ок, несколько — просьба уточнить) через `node-set-status`; `/luck-bug <title>` через новый RPC `bug-report` (severity `medium`). Ошибки — throw читаемого сообщения (хост репортит неудачный onSubmit), успех — открытие панели.
- `shared/rpc.ts`: +`goal-create` (draft, актор `user`, план ≥1 шаг), +`bug-report` (`{ok,error}`, severity default `medium` и в контракте, и в хендлере). `client/slash.ts` — чистая логика парсинга/резолва.
- Приёмка ✅: `tests/slash.test.ts` (13 тестов) + `tests/rpc.test.ts` (+6: регистрация 9 контрактов, draft с актором `user`, отказ пустого плана, дефолты жука, вложение листа, отказ чужого id); аудит-grep по `client/` — ноль; пункты и slash видны в хосте (живая проверка — на даэмоне в J2).

**E4. Settings screen** → `0.16.0` ✅
- `shared/settings.ts`: `defineSettings` с 5 полями (`injectIntoAgents`, `mcpServerName`, `httpPort` default 8899 / `0` auto, `accessToken`, `historyRetentionDays`); `normalizeSettings` для апгрейда старых доков настроек; `generateAccessToken` (WebCrypto, `lp_` + 256 бит). Сервер (`index.server.ts`) применяет `historyRetentionDays` при загрузке и на каждом `settings.subscribe` — без перезапуска демона, только reload плагина.
- `client/settings-screen.tsx` (новый): нативный экран в Settings → Plugins → Luck Planner (`SettingsInput`/`SettingsSwitch`/`SettingsAction` с regenerate токена), использует `useSettings` и `useHostFontScale`.
- `index.client.tsx`: регистрация `client.addSettingsScreen({ id: "luck-planner-settings", … })`.
- Приёмка ✅: `tests/d3-injection.test.ts` обновлён под новые дефолты (все 5 полей; в F1 список расширен до 6 — добавлен `httpEnabled`); `typecheck` + `vitest run` зелёные (262 тестов); значения сохраняются между рестартами даэмона (host-scoped settings хоста).

### Блок F — HTTP-транспорт дашборда

**F1. `server/http-server.ts`** → `0.17.0` — ✅ **выполнен**
- `server/http-server.ts`: `DashboardHttpServer` — `node:http` на `127.0.0.1`, пер-инсталляционный токен (query `?token=` или `Authorization: Bearer`, сравнение constant-time). Эндпоинты (read-only): `GET /health` (без токена), `GET /api/tree?project=` (узлы+пчёлы+жуки+их привязки+цели+рост одним ответом — готовый graph для раскладки), `GET /api/node/:id` (детали+история+связи), `GET /api/search` (FTS5 + фильтры kind/status/limit), `GET /api/stats`, `SSE /api/events` (заготовка для H1: `ready` + heartbeat + `broadcast`). Отдача SPA из `dist/dashboard` (index.html + assets, correct content-type, SPA-fallback, защита от traversal); пока сборки нет — честный placeholder.
- `server/http-lifecycle.ts`: `DashboardEndpoint` держит сокет в соответствии с настройками — debounce 150 мс (порт, набранный по цифре, даёт один restart), сериализованный restart, auto-генерация токена при пустом `accessToken`, auto-fallback на эфемерный порт при занятом, `status()` из живого сокета, `dispose()` реально освобождает порт.
- `shared/api.ts`: контракты JSON API (health + композитный tree), при этом `node`/`search`/`stats` **переиспользуют** output-схемы RPC (`shared/rpc.ts`) — одна форма для панели и дашборда. `server/store.ts`: новые read-only методы `listNodes` и `listBugAttachments`.
- Настройки: добавлен `httpEnabled` (default `true`) + переключатель в settings screen; `contribute` запускает endpoint по настройкам и останавливает его в cleanup (cleanup стал async и дожидается закрытия сокета).
- Приёмка ✅: `tests/http-server.test.ts` (16 тестов: health, 401 без токена/с неверным/с тем же хэшем, JSON согласован со shared-схемами, проектный скоуп, 405/404, SPA+traversal, SSE, освобождение порта) и `tests/http-lifecycle.test.ts` (9 тестов: off/on, эфемерный порт, pinned токен, debounce, fallback, restart, dispose, wiring через `contribute`). `typecheck` + `vitest run` зелёные (287 тестов).

**F2. «Открыть дашборд»** → `0.18.0` — ✅ **выполнен**
- `client/open-dashboard.ts` (новый, чистый модуль без React/SDK — по прецеденту `client/slash.ts`): `openDashboardUrl(url, openers, workspaceId?)` — приоритет `navigation.openBrowser({url, workspaceId})` (только Electron), фолбэк `openExternalUrl`; инжектируемые опенеры (`openBrowser`, `openExternal`, `listWorkspaceIds`), гвард `isOpenableDashboardUrl` (только абсолютные http/https), «хост сломался — не теряем URL» (throw из `openBrowser` уходит в фолбэк), пустой workspaceId = нет workspace.
- `client/dashboard-screen.tsx` (новый): SDK-обвязка `openDashboard({projectKey, workspaceId, readStatus, props, paseo})` → `{outcome, url, message}` и экран `LuckPlannerDashboardScreen`, который открывает дашборд при монтировании и показывает адрес + «Open again». Экран — единственный доступный SDK-путь: колбэк ⌘K-пункта не получает `navigation`, его получают только surface/panel/screen.
- `shared/rpc.ts`: +`dashboard-status` (`{enabled, listening, url, port, portFallback, error}`) — контракт отдаёт **живой** адрес сокета (токен + `?project=`), а не значения настроек. `server/http-lifecycle.ts`: `DashboardEndpoint.projectUrl(projectKey)`; `server/http-server.ts`: `DashboardHttpServer.urlForProject(projectKey)`; `shared/api.ts`: чистый `dashboardUrl(origin, token, projectKey?)`.
- `index.server.ts`: хендлер `dashboard-status`; `index.client.tsx`: кнопка в панели (ряд счётчиков) + пункт ⌘K «Open luck-planner dashboard» (`Globe`, workspace-контекст, открывает экран с `projectKey`/`workspaceId` в params) + `client.addScreen`.
- Приёмка ✅: `tests/open-dashboard.test.ts` (10 тестов: in-app browser приоритетом, discovery workspace, фолбэки — нет `openBrowser`/пустой список/упавший список/throw хоста, отказ не-http URL), `tests/http-server.test.ts` (`urlForProject` + 4 теста `dashboardUrl`, включая пути с пробелами), `tests/http-lifecycle.test.ts` (`projectUrl` живого/погашенного сокета + wiring-тест `dashboard-status` через `contribute`: URL реально отдаёт dashboard shell, а его токен принимает `/api/stats`), `tests/rpc.test.ts` (контракт-сет + выключенный endpoint). `typecheck` + `vitest run` зелёные (306 тестов).

### Блок G — Dashboard 2D: диаграмма (React Flow)

**G1. Каркас веб-приложения** ✅ → `0.19.0`
- `dashboard/`: React+TS, layout — toolbar (поиск, фильтры, переключатель 2D/3D-заглушка), canvas, details-panel, legend. Сборка esbuild → `dist/dashboard` (отдельный entry; ленивая подгрузка не нужна — пока только 2D).
- Приёмка ✅: страница открывается через F2, консоль браузера без ошибок, стили не завязаны на тему Paseo (собственная тёмная/светлая тема дашборда).
- Реализация: `dashboard/src/` — `app.tsx` (сетка toolbar/body/legend, живые счётчики из `/api/stats` через типизированный клиент `api.ts`, все ошибки — статусной строкой в toolbar), `theme.ts` + `colors.ts` (собственные палитры; полнота цветов/подписей по enum `shared/tree.ts` закреплена тестом), `params.ts` (разбор `?token=&project=`), компоненты `Toolbar/Canvas/DetailsPanel/Legend`. Сборка — esbuild `platform: browser`, `process.env.NODE_ENV` зафиксирован как `production` (иначе вкладка падает с `ReferenceError: process is not defined`), `dist/dashboard/index.html` + `assets/dashboard.js|css` с root-absolute URL для SPA-фолбэка. Свой `dashboard/tsconfig.json` с DOM-lib (корневой исключает `dashboard/**`), `npm run typecheck` гоняет оба. Тесты: `dashboard-params` (5), `dashboard-theme` (8), `dashboard-build` (7 — реальный сервер отдаёт реальный билд, браузерный клиент против реального store, детерминизм пересборки). 23 файла, 326 тестов зелёные.

**G2. Данные + раскладка** ✅ → `0.20.0`
- Data-адаптер `/api/tree` → React Flow nodes/edges (чистые функции, покрыты vitest без DOM): маппинг kind/status → тип узла, раскладка d3-hierarchy (radial или layered) + авто-зазоры, `collapse/expand` веток, корень-техстек и ствол выделяются формой.
- Приёмка ✅: адаптер-тесты (дерево из фикстур → ожидаемые positions/типы); на синтетике в 1000 узлов с collapse по умолчанию canvas остаётся отзывчивым.
- Реализация: `dashboard/src/graph.ts` — чистый адаптер (kind → type, `d3.tree()` layered-раскладка поверх *видимого* поддерева с авто-зазорами, `smoothstep`-рёбра дерева + рёбра-пчёлы с impact/status, openBugCount по определению `store.stats()`, `defaultCollapsedIds` держит видимое множество в бюджете 120 нод BFS-раскрытием уровней, `toggleCollapsed`). Canvas монтирует React Flow (`fitView`, `nodeTypes`, позиции layout-owned). Тесты: `dashboard-graph` (15 — фикстуры → positions/типы, collapse прячет поддерево и перекладывает, пчёлы видны только при видимых концах, лес без фантомной ноды, синтетика 1045 нод → ≤120 видимых, 10 пересборок < 1 с). 24 файла, 341 тест зелёные. Отклонение: выбран layered-расклад вместо radial (читаемость org-chart, fitView нормализует координаты).

**G3. Кастомные ноды и рёбра** ✅ → `0.21.0`
- Узлы: корень ⚙️, ствол, ветка 📦, лист с полосой статуса (план/в работе/готово) + `v{version} · r{revision}`; жуки 🐞 как ноды-бейджи на листах; цели 🎯 как групповые рамки под-деревьев. Рёбра-пчёлы 🐝 с типом/статусом.
- Приёмка ✅: визуальная сверка на фикстурах в реальном браузере; статус читается цветом И текстом (не только цветом); консоль чистая.
- Реализация: `colors.ts` +`STATUS_PROGRESS` (доля заполнения полосы: план→работа→готово), `GOAL_STATUS_COLORS/LABELS`, `BEE_STATUS_COLORS/LABELS`, `BUG_BADGE_COLOR`, `withAlpha`; `paletteIsComplete()` теперь охраняет и пчёл, и цели. `graph-nodes.tsx`: полоса статуса у листа (`role=img` + aria-label, текст статуса рядом), бейдж `🐞 ×N` с текстовым счётчиком, новый `GoalFrame` (пунктирная рамка с 🎯-подписью и статусом текстом). Рамки целей — синтетические ноды `goalFrame` в отдельном массиве `DashboardGraph.goalFrames` (bbox видимого материализованного поддерева, `GOAL_FRAME`-пэдинг, `zIndex:-1` + `pointer-events:none`, без рамки для неутверждённых целей ADR-7 и скрытых collapse поддеревьев, сортировка по id). Рёбра дерева — встроенный `smoothstep` + `stroke = withAlpha(цвет родителя, .5)`; пчёлы — свой тип `bee` → `BeeEdge` (bezier, цвет статуса, пунктир у resolved/cancelled, анимация у active, mid-path подпись `🐝 Status`, impact в `title`); `edgeTypes` не трогает встроенные типы (`EdgeWrapper`: `edgeTypes?.[type] || builtinEdgeTypes[type]`). Легенда: группа статусов пчёл + пояснения бейджей.
- **Багфикс в рамках этапа** (найден визуальной приёмкой): `DashboardApi` вызывал `fetch` методом экземпляра → в реальном браузере `window.fetch` бросал `Illegal invocation`, дашборд не загружал ни одного пейлоада (Node-тесты это не видят, т.к. fetch игнорирует receiver). Фикс — `fetchImpl.call(globalThis, …)`; регрессия — тест «global receiver» с receiver-strict-стенд-ином в `tests/dashboard-build.test.ts`.
- Приёмка ✅: `tests/dashboard-graph.test.ts` (+7: геометрия рамки, отсутствие без материализации, сжатие при collapse, падение при скрытии предком, сортировка, тип `bee`, тинт рёбер), `dashboard-theme.test.ts` (+4), `dashboard-build.test.ts` (+1). `typecheck` + `vitest run` зелёные (24 файла, 353 теста).

**G4. Интерактив** ✅ → `0.22.0`
- Клик по узлу → details-panel (REST `/api/node/:id`: версия, ревизия, статус, пчёлы, жуки, история); подсветка всех связей выбранного узла (пчёлы + жуки); поиск с фокусом камеры на узле; фильтры по типу/статусу/версии; зум/пан/fitView.
- Приёмка ✅: ручной сценарий в реальном браузере — «найти лист поиском → увидеть его блокеры и всё, чем он связан, без скролл-охоты» пройден; консоль чистая.
- Реализация: `graph.ts` +`GraphFilter` (kind/status/version-prefix, AND; выживают предки-контекст, collapse сильнее фильтра), `openBugIds` в данных узла, чистые хелперы `isFilterActive`/`matchesFilter`/`ancestorsOf`/`graphNodeCenter`/`relatedByOpenBug`/`edgeTouchesNode` + тип `FocusRequest`. `Canvas.tsx`: `onNodeClick`/`onPaneClick` → выбор; декорирование нод `selected`/`bugLinked` (общий открытый жук — «след блокера» в обе стороны) и подсветка всех касающихся рёбер (tree + bee, `lp-edge-emphasis`); внутренний `FocusController` (`useReactFlow().setCenter`, zoom ≥0.85, анимация). `DetailsPanel.tsx`: реальный контент `/api/node/:id` — крошки, kind/статус (точка+текст), `v·r`, обновление, прогресс growth (`growthProgress`), инциденты с блокерами (красная рамка), influence-ссылки с именем встречного узла и impact, дети, последние 20 строк истории. `Toolbar.tsx`: живой FTS-поиск (Enter, свой draft) + три фильтра (kind/status/version-prefix). `app.tsx`: состояние selection/detail/filters/focus, загрузка детали со stale-guard, `revealNode` при поиске (раскрыть предков + снять конфликтующие фильтры), статус-строка «Found … / N matches — showing …», пустое состояние канваса при активных фильтрах.
- Приёмка ✅: `tests/dashboard-graph.test.ts` (+10: активность/AND/префикс фильтров, контекст-предки, пустой результат, collapse-победа, цепочка предков с циклом, центр ноды, `relatedByOpenBug` только для открытых жуков, касание рёбер обоих слоёв). `typecheck` + `vitest run` зелёные (24 файла, 363 теста).

**G5. Темпы роста на диаграмме** ✅ → `0.23.0`
- Слой прогресса: прогресс-бар внутри узла цели/узла + режим тепловой карты по всему дереву (доля выполненных шагов growth).
- Приёмка: фикстура с тремя целями (0 %, 50 %, 100 %) различима визуально; переключение слоя не ломает раскладку.
- Реализация ✅: `shared/growth.ts` +`GrowthSummary`/`summarizeGrowth` (один арифметический слой на базе C4-`growthProgress`). `graph.ts`: `nodeGrowthRollups` — один пост-обход (дети раньше родителя), свёртка **собственной записи узла + записи цели, материализованной в этом узле + ролл-апов детей**; `hasOwn`/`ownStatus` описывают только собственную запись узла; отсутствие записей = `growth: null` (отличается от 0 %), ролл-апы считаются по всему дереву (collapse/фильтры меняют отображение, не счёт). Запись цели, никогда не материализовавшейся, не учитывается (ADR-7). Кадр цели рендерит ролл-ап своего материализованного корня — числа кадра и дерева совпадают по построению, двойного счёта нет. `colors.ts`: `HEAT_RAMP` (серый `#5c6470` → янтарный `#e0a84f` → зелёный `#4fa860`) + `heatColor(ratio)` (RGB-интерполяция, клампинг, тотальная), `GROWTH_STATUS_COLORS/LABELS` в `paletteIsComplete()`. Опция `BuildGraphOptions.layer: "status" | "growth"` — чисто отображающая: позиции/типы/рёбра идентичны (тест сравнивает скелеты двух слоёв). `graph-nodes.tsx`: полоса роста у любого узла с ролл-апом (`N/M steps` + свой статус или `· subtree`), полоса в подписи кадра цели (геометрия `GOAL_FRAME` не менялась), тинт корпуса `withAlpha(heatColor(ratio), 0.22)` при сохранении border по kind. `Toolbar.tsx`: второй сегментный переключатель Status/Growth heat; `app.tsx`: состояние слоя + честная подсказка «нет записей growth»; `Legend.tsx`: шкала heat с «growth 0 % → 100 %».
- Приёмка ✅ (реальный браузер, фикстура с тремя целями 0/50/100 %): нулевая нода — `rgba(92,100,112,.22)` (серый), 50 % — `rgba(224,168,79,.22)` (янтарь), 100 % — `rgba(79,168,96,.22)` (зелёный), полосы кадров 0 %/50 %/100 %, ноды без записей нейтральны; трансформы нод до и после переключения идентичны (раскладка не двигается); клик по ноде по-прежнему наполняет панель деталей; светлая тема проверена так же; консоль чистая. `typecheck` (оба конфига) + `vitest run` зелёные (24 файла, 382 теста).

### Блок H — Живые данные

**H1. SSE + инвалидация кэша** ✅ → `0.24.0`
- `/api/events`: событие `tree-changed` после любой записи (store → event bus → SSE); дашборд слушает и делает refetch изменённого поддерева. В нативной панели — инвалидация TanStack Query по тем же событиям (RPC-опрос или подписка).
- Приёмка: e2e-сценарий — статус листа меняется MCP-инструментом, дашборд и панель обновляются без ручного refresh.
- Реализация: ключевое решение — **не хук на `store.write`, а опрос журнала**. Агенты пишут через MCP-сервер, *другой процесс* с собственным соединением к тому же SQLite (ADR-3), поэтому внутрипроцессный хук видел бы только мутации панели и молча терял все агентские записи — ровно сценарий приёмки. Общее у процессов — файл, и каждая мутация пишет ровно одну строку в `history` (правило B3), поэтому `server/change-feed.ts` опрашивает `history.id > watermark`: индексированное чтение по первичному ключу. `ChangeFeed` (start/stop, `unref`-таймер, дебаунс собственных тиков, остановка после 3 подряд сбоев, группировка по проекту), `readChangesSince` — дренаж пачками с честным watermark (никогда не впереди уже отданных строк, ремонт «съехавшего» курсора после пересоздания БД), `groupByProject`. `store`: `latestHistoryId()` + `listChangesSince()` (только чтение). `http-server.ts`: SSE-стрим помнит `?project=`, `broadcast(event, data, projectKey?)` будит только свои табы (в демоне несколько workspace), `ready` несёт `{version, watermark}` — переподключившийся таб видит, что пропустил. `http-lifecycle.ts` владеет потоком: стартует/останавливает его вместе с сокетом, отдаёт `watermark` в `ready`. `shared/api.ts`: `readyEventSchema` + `treeChangedEventSchema` (строки — те же `historyEntrySchema`, что у `/api/node/:id`) + `changesTouchNode` (общее правило «эта партия делает вид узла устаревшим»). Дашборд: `dashboard/src/live.ts` (чистый модуль над инъекцией `EventSource`: парс, коалесинг всплеска в один refetch, отличие переподключения от первого открытия, самоизлечение на неразбираемом payload), `api.ts.eventsUrl()`, `app.tsx` — рефетч проекта и панели деталей, индикатор `live/offline` в тулбаре. Панель: SDK не имеет server→client push, поэтому `tree-changes` — RPC-двойник события (`sinceId` отсутствует = «только курсор»), опрос раз в `PANEL_CHANGE_POLL_MS` (2 с) при открытой панели, без ручного Reload; TanStack Query в панели не используется — вместо неё этот опрос.
- Приёмка ✅ (тестами на реальных артефактах): `tests/change-feed.test.ts` (13: дренаж/кап/курсор впереди таблицы, группировка, старт с головы журнала, запись через **второе соединение к тому же файлу** — модель агентского процесса, коалесинг всплеска, падающий листенер не сбрасывает курсор, остановка при исчезнувшей БД, интервал + `stop`); `tests/http-lifecycle.test.ts` (+3: запись вторым соединением доходит до открытого SSE-потока как `tree-changed`; поток, открытый на другой проект, не будится; `ready` с версией и watermark); `tests/http-server.test.ts` (+1: `ready`-курсор и сужение broadcast по проекту); `tests/dashboard-live.test.ts` (10: парс/merge/коалесинг/close/`offline` без EventSource/`changesTouchNode`); `tests/rpc.test.ts` (+2: `tree-changes` не переигрывает журнал и отдаёт дельту только своего проекта); `tests/dashboard-build.test.ts` (+2: `eventsUrl` реально открывает поток, в бандле есть `/api/events`, `tree-changed`, `lp-live`). Живой сценарий с настоящим MCP-инструментом и браузером — в J2. `typecheck` (оба конфига) + `vitest run` зелёные (26 файлов, 411 тестов).

**H2. Timeline-строки агента** ✅ → `0.25.0`
- `paseo.agents.ref(id).timeline.append` о ключевых фактах (цель утверждена, лист доведён до done) с рендерером plugin-item; данные ≤ 64 KiB.
- Приёмка: строка видна в таймлайне агента, рендерер зарегистрирован (нет «unavailable»).
- Реализация: три новых модуля. `shared/timeline.ts` — контракт: `kind = luck-planner-event`, `version = 1`, `timelineDataSchema` и сборщик `buildTimelineItem`, который режет поля по байтовым клампам; сумма клампов × 6 (максимум для JSON-escaping) ≈ 24 КиБ — вдвое меньше лимита SDK 64 КиБ даже на адверсариальном вводе, и `timelineDataBytes` это измеряет в тестах. `id` строки = `lp-<event>-<entityId>-r<revision>`: повторная отправка того же перехода заменяет строку, новый переход — новая строка. View-model (`timelineRowText`) лежит там же, а не в компоненте: vitest не грузит Flow-исходники `react-native`. `server/timeline.ts` — `keyFactFor` (структурно: `node`+`status` с переходом в `done` и `goal`+`approve`; остальные строки журнала не срабатывают), `rowFor`, `agentCandidates` (действующий агент → последний не-`user`-актор той же сущности, ≤8 кандидатов, каждый — не больше одного запроса к даэмону) и `notifyTimelineChange`; `timelineSink` — структурный адаптер над `PaseoApi` без зависимости от `@getpaseo/client`: `refresh()` отвечает «это настоящий агент», любая ошибка — это «не агент», ошибки append логируются и не всплывают в фид. `index.server.ts` — **второй** `ChangeFeed`, а не дашбордный: дашбордный живёт только пока открыт сокет и намеренно пропускает строки, написанные во сне (таб и так перезагружает всё при коннекте), а timeline-строка должна появляться и с выключенным HTTP; две независимые головки курсора = ещё один индексированный `SELECT` в секунду. SDK-хэндла на момент `contribute` не существует — его отдают контексты `before`-хуков и RPC-хендлеров, поэтому регистрация хендлеров идёт через локальную обёртку `handle` вместо прямого `server.handle`, и первая дошедшая контекст-пара запоминается. Клиент: `client/timeline-row.tsx` (RN-примитивы, цвета из `theme.colors`, `layout.compact`, `useHostFontScale`) + `addTimelineRenderer` теми же константами и схемой из `shared/timeline.ts`.
- Приёмка ✅ (тестами на реальных артефактах): `tests/timeline.test.ts` (36: классификатор ключевых фактов и `rowFor`; клампы и 64 КиБ на адверсариальном вводе; кандидаты-агенты — порядок, дедупликация, кап, «всё human → некому»; `notifyTimelineChange` на файловом store — включая «цель утверждена человеком → строка уходит предложившему её агенту», «ни одного агента → тихий пропуск», отклонённый append, отсутствие хэндла; wiring через `contribute`: запись **вторым соединением к тому же файлу** доходит до фида и превращается в строку, хэндл запоминается из RPC-контекста (панельный сценарий без единой сессии агента), cleanup останавливает опрос; source-контракт регистрации рендерера). Два старых fake-сервера теперь передают контекст хендлера явно (`{paseo: undefined}`) — ровно то, что SDK передаёт всегда. `typecheck` (оба конфига) + `vitest run` зелёные (27 файлов, 447 тестов). Ручная приёмка в живом даэмоне (строка видна в таймлайне, «unavailable» отсутствует) — в J2.

### Блок I — Dashboard 3D: дерево (**последний блок**, только после зелёного G+H)

**I1. Спайк WebGL + фиксация библиотеки** ✅ → `0.26.0`
- Проверить WebGL в workspace browser (Electron) и во внешнем браузере на целевых клиентах; зафиксировать в `__doc.md`: `@react-three/fiber` + `drei` + `d3-hierarchy`; фолбэк-поведение при отсутствии WebGL (показать 2D + пояснение). Ленивый entry `dashboard-3d.js` (загружается только при переключении — не раздувать первый чанк).
- Приёмка: пустая сцена с OrbitControls рендерится в табе Paseo; фолбэк срабатывает при `--disable-webgl`.
- Реализация: библиотеки зафиксированы — `three` + `@react-three/fiber` + `@react-three/drei` (пин в `package.json`), раскладка I2 остаётся на `d3-hierarchy`, что уже использует 2D-адаптер. Ключевое решение сборки — esbuild `splitting: true` с двумя entry (`dashboard`, `dashboard-3d`): общие модули (react, jsx-runtime) уходят в `chunk-*.js`, поэтому в странице ровно один React (два сломали бы каждый хук), а `three`/r3f/drei живут только в ленивом `dashboard-3d.js` (~2,1 МиБ без минификации — репозиторий коммитит читаемые бандлы), который браузер запрашивает лишь по нажатию «3D»; `index.html` его не ссылкует. Детект — `dashboard/src/webgl.ts`: инжектируемая canvas-фабрика (тестируется в vitest без DOM), попытки `webgl2` → `webgl` → `experimental-webgl`, освобождение probe-контекста через `WEBGL_lose_context` (браузеры ограничивают число живых контекстов), никаких исключений — отсутствие canvas/контекста или бросающий `getContext` (заблокированный драйвер) отвечают `{ok: false, reason}`. Политика в одном месте — `planViewSwitch`: без WebGL запрос 3D сохраняет 2D-диаграмму и пишет причину в статус-строку (принятие `--disable-webgl`), возврат в 2D всегда молчит. Сцена монтируется императивно (`mountScene3D(container, onError?) → {dispose()}` из `dashboard-3d.tsx`): вызывающий владеет контейнером, `dispose()` идемпотентен, размонтирует React-root сцены (ReactDOM-root вокруг `<Canvas>` r3f — не `createRoot` из r3f, который ждёт canvas; баг найден живой проверкой в I3) и очищает ячейку — после возврата в 2D не остаётся ни рендерера, ни цикла анимации, ни canvas. `components/ThreeView.tsx` — единственная точка загрузки: импортирует из модуля сцены **только тип**, динамический `import()` на маунте, состояния `loading/ready/failed` в общую статус-строку; `failed` возвращает таб на 2D.
- Приёмка ✅ (тестами на реальных артефактах): `tests/dashboard-3d.test.ts` (18: детект на фейках — webgl2/webgl1/experimental-флоор, «нет контекста», «нет canvas», бросающая фабрика, освобождение контекста; политика переключения — отказ 3D с письменной причиной; артефакты — `dashboard-3d.js` существует, ровно один `import("./dashboard-3d.js")` в первом чанке, ни одного маркера `OrbitControls`/`gridHelper`/`WebGLRenderer` в нём, `index.html` не ссылкует ленивый entry; source-контракты — только тип-импорт, пара mount/dispose, все запросы 3D через `planViewSwitch`). Тест детерминизма в `tests/dashboard-build.test.ts` теперь хеширует и 3D-чанк. `typecheck` (оба конфига) + `vitest run` зелёные. Рендер в живом табе (Electron + внешний браузер) и `--disable-webgl` вручную — в J2; на этапе I3 встроенный браузер Paseo стал доступен, и первая же живая проверка нашла баг монтирования (см. раздел I3).

**I2. 3D-дерево: раскладка + геометрия** ✅ → `0.27.0`
- Та же graph-модель → 3D: depth → высота, x/z — радиальное расположение; корень — сфера с техстеком, ствол — цилиндры, ветки — трубы (толщина по числу листьев), листья — спрайты с цветом статуса.
- Приёмка: дерево фикстур читается как дерево (видна иерархия без кликов); инстансинг листьев, бюджет — плавные 5–10 тыс. узлов.
- Реализация: раскладка — чистый модуль `dashboard/src/tree-3d.ts` (без three/DOM, живёт в первом чанке рядом с `graph.ts`): `indexTree` (детерминированный индекс 2D-адаптера) → `hierarchy` + `tree().nodeSize([1, levelHeight])` из d3-hierarchy → **радиальный конус**: depth → высота (самые глубокие факты лежат на сетке), siblings расходятся по углам вокруг оси ствола (нормировка по максимальному разбросу даёт полный круг широким деревьям и веер узким), кольца растут с глубиной. Синтетический «лесовой» корень оборачивает несколько корней и узлы с осиротевшим `parentId` (правило `indexTree`), при эмиссии отбрасывается — апекс-узлы (без реального родителя) помечаются `isRoot` и рисуются сферой, поэтому даже сирота-ствол не исчезает. `subtreeLeafCounts` — пост-проход за O(n); `tubeRadius(leaves) = clamp(tubeMin, √leaves·0.055, tubeMax)` — √-масштаб по площади сечения: 4× листьев = 2× толщина, одиночный лист висит на самой тонкой трубе. Геометрия сцены (`dashboard-3d.tsx`): `TreeScene` поверх I1-спайка (сетка по габаритам модели, `CameraFit` — однокадровая посадка камеры по приходу модели, без борьбы с мышью), корень/апекс — `sphereGeometry`, каждое ребро — цилиндр, ориентированный кватернионом вдоль сегмента (ровно по длине щели, без z-fighting), листья — **один** `InstancedMesh` с палитрой `STATUS_COLORS` из `colors.ts` (общей с 2D-легендой) и покадровым билбордингом через кватернион камеры (`compose` на инстанс — субмиллисекундно на 10k). Данные текут: `app.tsx` (`buildScene3D(tree.nodes)` по памяти, пересборка только при смене дерева) → `ThreeView model=` → `handle.setModel` (внешний стор + `useSyncExternalStore`, без ремаунта рендерера); `setModel(null)`/до загрузки дерева — спайк-сцена I1, никогда не чёрный вьюпорт. Трубчатый счётчик: число труб = число внутренних узлов (в реальных деревьях это сотни, листья — инстансы), LOD/инстансинг труб по замерам I3–I4.
- Приёмка ✅ (тестами на реальных артефактах): `tests/dashboard-tree-3d.test.ts` (13: фикстуры из реального `LuckPlannerStore` — корень в апексе центра, каждый уровень ровно на `levelHeight` ниже, листья на сетке; веер соседей — общее кольцо, разные углы; одно ребро на не-корневой узел с точными концами; толщина строго по числу листьев (billing 4 > platform 3 > api 2 > storage 1 = пол); подмножества сфер/спрайтов со статусами; чистая функция (два билда идентичны); пустой проект / один корень / сирота-`parentId` → лес; `tubeRadius` — клампы и √-масштаб; `subtreeLeafCounts`; бюджет: 10k синтетических узлов раскладываются за <500 мс (фактически ~90 мс), 9 999 рёбер, >6k спрайтов в одном инстансе). Бандл-маркеры в `tests/dashboard-3d.test.ts`: лейаут (`buildScene3D`, `LAYOUT_3D`) — в графе приложения (main + общий chunk, который браузер и так качает), геометрия (`instancedMesh`/`setMatrixAt`/`setColorAt`/`sphereGeometry`/`cylinderGeometry`) — только за динамическим импортом, ленивый файл не содержит ни одной функции лейаута. `typecheck` (оба конфига) + `vitest run` зелёные. FPS/замеры на живых 5–10k — в J2.

**I3. Пчёлы, жуки, цели, рост в 3D** ✅ → `0.28.0`
- Пчёлы — анимированные частицы, летящие по рёбрам (статус/ревизия в тултипе); жуки — пульсирующие красные узлы на листьях; цели — парящие кольца/сферы над под-деревьями; темпы роста — свечение/прогресс-кольца.
- Приёмка: каждый тип связей различим на глаз; анимация не деградирует FPS на 1000 узлов (замер).
- Реализация: новый чистый модуль `dashboard/src/overlay-3d.ts` (без three, живёт в первом чанке рядом с `graph.ts`) — четыре проекции одной полезной нагрузки, каждая своей геометрией, поэтому их нельзя спутать глазом. **Пчёлы**: квадратичная кривая Безье между двумя листьями (прямые трубы дерева — это рёбра, дуга читается как связь); подъём ∝ длине хорды с клампом, сдвиг наружу от оси ствола, и **отдельная полоса** для пчёл с той же парой листьев (ключ пары канонический, поэтому A→B и B→A разводятся, как 2D-рёбра). **Жуки**: маркер на каждый *блокирующий* инцидент (`open` + `investigating` — определение берётся из `graph.ts#openBugIdsByNode`, а не выдумывается) на каждый привязанный лист; один инцидент пульсирует в одной фазе на всех своих листьях. **Цели**: кольцо над ограничивающей окружностью материализованного под-дерева (ADR-7), радиус — половина диагонали бокса + запас, высота — над самой высокой нодой именно этого под-дерева; roll-up роста берётся из той же карты, что и 2D-рамка. **Рост**: гало на каждой ноде с данными роста, `heat` — ровно тот же `growthRollups`, что красит 2D heat-слой (единая функция, вынесенная из `graph.ts` и переиспользованная обоими видами); переключатель слоя toolbar решает, есть ли гало вообще — как и в 2D. Вся анимация — чистые функции в этом же модуле: `beeProgress`/`beeArcPoint` (без аллокаций, через out-вектор), `bugPulseScale` (фаза из стабильного id, период), `growthGlow` (одно значение на весь слой) и `haloScale`; фазы — из FNV-1a-хеша id, никогда из `Math.random()`, поэтому SSE-рефетчи H1 не перетасовывают рой. Сцена (`dashboard-3d.tsx`): рой пчёл, маркеры жуков и гало роста — по одному `InstancedMesh` каждый; кольца целей — отдельные меши (целей по природе мало); листья и гало получили `raycast={() => null}`, чтобы движение мыши не рейкастило 10k инстансов. Наведение: наведённая пчела **замирает** (иначе тултип уезжает от указателя), и один `<Html>` drei монтируется только на время наведения — статус/ревизия пчелы, серьёзность/статус/заголовок жука, статус/прогресс/текст цели (тексты — чистые `beeTipText`/`bugTipText`/`goalTipText`, покрыты тестами). `ThreeView`/`app.tsx` передают оверлей вместе с моделью одним вызовом `handle.setScene(model, overlay)` — это один вид одной полезной нагрузки, и два сеттера могли бы отрисовать оверлей от прошлого дерева. Легенда дополнена строкой про 3D-формы той же палитры.
- Приёмка ✅ (тестами на реальных артефактах): `tests/dashboard-overlay-3d.test.ts` (22: дуги — концы равны позициям листьев, апекс выше хорды, полосы разведены ровно на `beeLaneSpacing`, пчела на отсутствующий лист отбрасывается; анимация — `beeProgress` в `[0,1)`, старт с фазы, шаг на цикл, `beeArcPoint` в точках u=0/1 и без аллокаций; жуки — маркер на каждый лист блокирующего инцидента, resolved невидим, позиция поднята на `bugLift`, фаза едина у одного инцидента, пульс в окне и с периодом; цели — центр выше своего под-дерева, `nodeCount` = 3, roll-up `1/2` совпадает с 2D goal-frame, `nodeCount` тоже, неутверждённая цель не рисуется; рост — в слое `status` список пуст, в слое `growth` множество нод и все `heat` совпадают с 2D `buildGraph`, включая roll-up родителя и отсутствие гало у листа без данных; детерминизм двух сборок, пустой проект → `EMPTY_OVERLAY`, `hashUnit` в `[0,1)`, `truncate`; бюджет — 10k нод + 200 пчёл + 50 жуков + 1000 записей роста: сборка оверлея < 500 мс, 60 кадров чистой анимации < 300 мс). `tests/dashboard-3d.test.ts` (+2 и расширенный маркерный тест: `buildSceneOverlay`/`beeArcPoint` — в графе приложения, в ленивом чанке `buildSceneOverlay` нет, а формы (`BeeSwarm`/`BugMarkers`/`GoalRings`/`GrowthHalos`, `octahedronGeometry`, `torusGeometry`, `Html`) — только за динамическим импортом; source-контракт «сцена ни разу не обходит список нод» (`model.nodes` не встречается) и type-only импорт оверлея в загрузчике). `typecheck` (оба конфига) + `vitest run` зелёные (30 файлов, 504 теста). Отдельно устранён источник флаки: тесты детерминизма сборки больше не пересобирают общий `dist/` (новый флаг `scripts/bundle.mjs --outdir <dir>`, сборка в temp + сравнение с коммитным артефактом по всему дереву файлов), из-за чего параллельные тесты, читающие `dist/dashboard/assets/chunk-*.js`, иногда падали на гонке со sweep'ом. Живой прогон (FPS на реальных 5–10k, вид тултипов, читаемость четырёх форм в браузере) — в J2. Живая проверка этапа: встроенный браузер Paseo (Electron/Chromium) против **реального** `DashboardHttpServer` + засеянного `LuckPlannerStore` — 2D-дашборд рисует реальный пейлоад (счётчики, фильтры, live-бейдж), кнопка «3D» монтирует сцену (canvas, живой WebGL-контекст, статус `live`). Именно эта проверка нашла баг, проживший I1–I2: `mountScene3D` отдавал `<div>` в `createRoot` из r3f (тот ждёт `<canvas>`) → `canvas.getContext is not a function`, 3D не открывался ни в одном браузере, а артефактные тесты этого не видели. Фикс: ReactDOM-root вокруг `<Canvas>` + error boundary и `onError`-канал — падение рендерера после пройденного probe даёт ту же строку статуса и фолбэк на 2D. Скриншоты в хосте недоступны (вкладка открывается в фоне и не перерисовывается), поэтому FPS на реальных 5–10k, вид тултипов и читаемость четырёх форм остаются за J2.

**I4. Интерактивность 3D + переключатель 2D/3D** ✅ → `0.29.0`
- OrbitControls, raycaster-клик → **та же** details-panel (общий компонент с 2D), Html-подписи (drei) для фокусного узла, фокус камеры из поиска, фильтры по типу/статусу/версии; переключатель 2D/3D в toolbar (состояние в URL/localStorage); LOD/инстансинг по результатам замеров I2–I3.
- Приёмка: сценарий «найти лист → клик → детали → подсветка связей» идентичен в 2D и 3D; переключение сохраняет выбранный узел.
- Реализация: решения — в новом чистом модуле `dashboard/src/pick-3d.ts` (без three и DOM, живёт в первом чанке рядом с `graph.ts`/`tree-3d.ts`): `pickNode` (рей/сфера, ближайшее попадание выигрывает), `pickCandidates` (радиус по виду ноды: спрайт листа, сфера апекса, «сустав» внутренней ноды), `selectionHighlight` (ноды с тем же блокирующим инцидентом, пчёлы ноды, трубы самой ноды и её детей) и `focusTarget` (позиция + расстояние). Сцена только рисует: клик обрабатывается на самом canvas (не через r3f-события — 10k инстансов остаются вне рейкаста, как правило I3), драг считается орбитой, а не кликом, клик в пустоту снимает выделение (как клик по холсту в 2D). Выделение рисуется как в 2D, пункт в пункт: выбранный лист и «родственники по инциденту» — своим цветом, трубы ноды — цветом выделения, связи ноды — кривыми по самим дугам пчёл (`beeArcPoints`), плюс кольцо и подпись `Html` (имя · вид · статус). Камера летит к ноде из поиска, сохраняя текущее направление обзора (0,7 с smoothstep, вместе с орбитальной целью); перекадрирование — только когда меняются **данные** (`fitKey` от полезной нагрузки), поэтому live-рефетч и сужение фильтром не выдёргивают камеру. Фильтры toolbar доходят до 3D: `buildScene3D(nodes, { filter })` использует собственное правило 2D-адаптера (`matchingWithAncestors`, вынесено из `buildGraph` и разделяемое обоими видами) — одна трактовка на два вида; коллапс остаётся заботой 2D-холста. Состояние вида — новый чистый модуль `dashboard/src/view-state.ts`: URL (`?view=3d`) важнее localStorage, 2D — умолчание, неизвестное значение игнорируется, перезапись URL сохраняет токен и проект; про WebGL решает не он, а probe и `planViewSwitch` (I1). Инстансинг по замерам I2–I3: трубы больше не отдельные меши — один `InstancedMesh` (единичный цилиндр, масштаб инстанса `(radius, length, radius)`, поворот кватернионом, толщина по √листьев поддерева сохранена); фикстура 92 ноды / 91 труба / 75 листьев рисуется за **7 draw calls** (10 с подсвеченными связями); билбординг листьев пропускает кадр, когда камера не двигается.
- Приёмка ✅ (тестами на реальных артефактах + живой прогон в браузере): `tests/dashboard-pick-3d.test.ts` (24: рей/сфера — попадание, промах, ближайший впереди, нода за началом луча, ненормированное направление, луч изнутри сферы, нулевое направление; кандидаты — по одной на ноду, радиус по виду; подсветка — родственники по инциденту (сверено с множеством 2D-адаптера `relatedByOpenBug`), пчёлы в обе стороны, трубы ноды и её детей, пустое выделение; фокус — позиция и расстояние, неизвестная нода → null; фильтры в 3D — тот же набор нод, что у 2D-графа, путь к корню сохранён, без фильтра все ноды; состояние вида — URL, хранилище, враждебное хранилище, приоритеты, перезапись с сохранением токена). `tests/dashboard-3d.test.ts` (+7 контрактов: решения пикинга — в графе приложения, отрисовка — за динамическим импортом; трубы — один инстансированный меш без списка мешей на ребро; сцена берёт чистый `pickNode`; загрузчик передаёт `interaction` и сообщает о клике; оба вида выбирают через один сеттер и наполняют одну панель; вид запоминается в URL и в хранилище; фильтры доходят до раскладки; HTML-оверлеи ждут первого кадра). `typecheck` (оба конфига) + `vitest run` зелёные (31 файл, 536 тестов). Живая проверка (встроенный браузер Paseo против реального `DashboardHttpServer` + засеянного `LuckPlannerStore`): клик по листу выбирает его и наполняет **ту же** details-panel (версия, ревизия, инциденты, связи); лист окрашен цветом выделения, его труба — тоже, две связи ноды нарисованы кривыми; поиск уводит камеру к найденной ноде (движутся и позиция, и орбитальная цель) и подписывает её; переключение 2D → 3D сохраняет выделение **и** подпись; фильтр по статусу сужает 3D-дерево с 75 листьев до 14. Живая проверка нашла и починила баг drei: `<Html>`, смонтированный в первом рендере сцены, не портирует свой контент в DOM (эффект зависит от ref группы, который на первом рендере ещё не привязан) — подпись не появлялась никогда; сцена теперь объявляет первый кадр (`SceneReady`), и HTML-оверлеи монтируются после него. FPS на живых 5–10k и читаемость форм — в J2.

### Блок J — Финализация (без бампа версии)

**J1. README.md (English) + ссылка в главный README** ✅ (без бампа версии — документация, не код)
- README плагина: что делает, установка, MCP-инструменты, дашборд 2D/3D, настройки; ссылка добавляется в корневой `README.md` в секцию Plugins (по правилам `AGENTS.md`).
- Приёмка: `README.md` и `__doc.md` полностью на английском; ссылка из корневого README рабочая.
- Реализация: `luck-planner/README.md` — краткое описание плагина для человека: что делает (дерево, пчёлы, жуки, цели с гейтом одобрения, рост, MCP-инструменты, дашборд, нативная панель, live-обновления, скилл агента), установка (`paseo plugin add …:luck-planner` + шаг сборки `npm ci`/`npm run bundle` и его артефакты), таблица всех восьми MCP-инструментов, раздел про дашборд (2D: раскладка, поиск, фильтры, details-panel, heat-слой; 3D: конус, дуги пчёл, пульсирующие инциденты, кольца целей, клик-пикинг в ту же панель, полёт камеры из поиска, запоминание 2D/3D; фолбэк без WebGL), панель/⌘K/слэш-команды, агентский скилл и его каталоги, таблица настроек, где лежат данные (`$PASEO_HOME/plugins/luck-planner/luck-planner.db`, аудит-трейл, дашборд только на чтение), разработка (`npm ci`/`bundle`/`typecheck`/`test`, карта исходников) и известные ограничения. Корневой `README.md`: строка в секции **Plugins**, команда установки, строка в таблице build-шага, строка в таблице **Compatibility** (+ сноска про требование Paseo ≥ 0.11.0 и про то, что живая установка в живой даэмон ещё не проверена) и раздел `__doc.md §10 Compatibility`, который честно разделяет «проверено кодом» и «проверяется на живом даэмоне» (это J2). Ссылки относительные, все ведут на существующие файлы.
- Приёмка ✅ (тестами): `tests/readme.test.ts` (8: README плагина существует и не заглушка; в `README.md` и `__doc.md` нет кириллицы — правило проекта; README называет **каждый** MCP-инструмент из кода (`MCP_TOOL_NAMES`), команду установки, дашборд, 2D/3D, WebGL и обе настройки; все относительные ссылки README плагина разрешаются в файлы на диске; корневой README линкует плагин в секции Plugins, показывает команду установки и строку в таблице build-шага; все относительные ссылки корневого README разрешаются). `typecheck` (оба конфига) + `vitest run` зелёные (32 файла, 544 теста).

**J2. Приёмочная e2e-проверка на живом даэмоне + финальный `__doc.md`** ✅ → `0.29.1`–`0.29.4` (три бага, найденных живой установкой) + финальный `__doc.md` (документация — без бампа)
- Чек-лист: установка из git-источника (`paseo plugin add ...:luck-planner`), `running` без ошибок; агент через MCP создаёт/обновляет лист; человек утверждает цель из панели; дашборд открывается в табе Paseo; 2D и 3D проходят сценарий G4/I4; SSE обновляет оба вида; тёмная/светлая тема, compact; `paseo plugin logs` чистый. Замеры (узлы, FPS, размер бандла) — в `__doc.md`.
- Приёмка: всё из чек-листа подтверждено и записано; известные ограничения перечислены явно.
- Реализация (приёмка на живом даэмоне Paseo 0.12.0, установка из git-источника): `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner` → плагин собран хостом в своём клоне (`npm ci`, `npm run bundle`) и загружен оттуда. Чек-лист пройден целиком, результаты — в `__doc.md §10` (13 пунктов, замеры: 60 fps в живом 3D, 6 draw calls, первый загруз 1 773 КиБ, ленивый 3D-чанк 2 114 КиБ, MCP-бандл 869 КиБ, консоль чистая — одно предупреждение three.js о deprecated `THREE.Clock`).
- **Три реальных бага, которых не видели артефактные тесты** (все — про build хоста и жизненный цикл даэмона, а не про код):
  - **`0.29.1` — CommonJS-ловушка.** Хост грузит серверный код плагина, транспилируя его TypeScript, и этот build — **CommonJS**: там `import.meta` пустой объект, поэтому `new URL("../dist/dashboard/", import.meta.url)` кидал `Invalid URL` (дашборд не поднимался вообще, а `resolvePluginVersion()` тихо деградировал в `0.0.0`). Фикс — `server/module-dir.ts`: каталог модуля ищется через ту дверь, которая есть в сборке (`import.meta.url` в ESM, `__dirname` в CJS). Регрессия — `tests/module-dir.test.ts`: собирает модуль esbuild'ом в формате CommonJS (как хост) и спрашивает у *собранного* модуля, где его файлы.
  - **`0.29.2` — файлы не рядом с кодом.** Дашборд поднялся, но отдавал placeholder («web app is not built in this checkout»): хост грузит код из своего каталога, а файлы плагина лежат в checkout'е, который знает только конфиг даэмона (`$PASEO_HOME/config.json` → `plugins["luck-planner"].path`). Фикс — `server/plugin-paths.ts`: единое место «где мои файлы» (конфиг → модуль → `process.cwd()`), а кандидат считается пригодным только если в нём есть `index.html`.
  - **`0.29.3`/`0.29.4` — опубликованный MCP-entry умирал вместе с ревизией.** Entry был симлинком в каталог ревизии, а даэмон удаляет предыдущую ревизию сразу после загрузки новой → висячая ссылка → у каждого агента `Cannot find module`. Фикс — публикация **копией** (файл, а не ссылка) + обновление в момент, когда даэмон завершил установку (`applySettings` — конфиг к этому моменту уже переписан). Живой запуск это показал: handshake отдавал `0.29.2` при плагине `0.29.3` — копия была из старой ревизии.
- Известные ограничения, зафиксированные явно: клик по панели (утверждение цели) — нативная поверхность без автоматизации, поэтому в приёмке вызывается тот же доменный вызов, что делает RPC панели; содержимое консоли браузера хост-автоматизация не отдаёт, поэтому проверка сделана пробником в *установленном* checkout (потом убран); предупреждение three.js о `THREE.Clock` — стороннее, из r3f; 10k-бюджет остаётся измеренным на синтетике (тесты), а живой проект выше — другое доказательство.

## 5. Порядок версий и тегов

| Этап | Версия | Этап | Версия |
|------|--------|------|--------|
| A1 | 0.1.0 | E1–E4 | 0.13.0–0.16.0 |
| B1–B4 | 0.2.0–0.5.0 | F1–F2 | 0.17.0–0.18.0 |
| C1–C4 | 0.6.0–0.9.0 | G1–G5 | 0.19.0–0.23.0 ✅ |
| D1–D4 | 0.10.0–0.12.0, 0.30.0 | H1–H2 ✅ | 0.24.0–0.25.0 |
| | | I1–I4 | 0.26.0–0.29.0 (I1–I4 ✅) |
| | | J1 | — (документация, без бампа) |

Каждый бамп — анонсированный тег `luck-planner@<версия>` на коммите с этой версией, отправка в origin (правило проекта). Слово «release» в задаче не используется — major-бамп не планируется. Блок J — финализация без бампа версии: J1 меняет только документацию, J2 — приёмку.

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
