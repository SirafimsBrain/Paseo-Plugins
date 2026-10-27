# remote-control — план разработки (атомарные этапы)

> **Статус: 0.19.10 — хранилище как основа:** первичная инициализация
> (создание мастер-пароля) и разблокировка — только в правой панели, группы
> с подключениями отображаются только после открытия хранилища; ручное
> управление секретами убрано (ни Secrets-вьюхи, ни `/api/secrets`, ни
> HTTP-маршрутов vault setup/unlock/lock) — секретами управляют только формы
> создания/изменения подключения; мастер-пароль в формах подключения больше
> не вводится (закрытое/не созданное хранилище → явная ошибка с указанием на
> панель, до создания записи). Пароль подключения живёт в vault
> (`connections/<id>/password`); запуск ssh — во вкладке Paseo, rdp/vnc —
> внешним окном (0.18.10); кнопки создания «голого» терминала убраны;
> блоки E/F начаты как лаунчеры (без discovery и опций).**
> (см. §2 ADR-5/ADR-6/ADR-14, §6, Блоки B/C/E/F/G и `__doc.md`).
> План собран по результатам исследования исходных материалов (см. §1),
> решений заказчика, зафиксированных до начала планирования (см. §2),
> и правил `AGENTS.md` (версия + анонсированный тег на каждый этап).

**Принцип:** каждый этап — один независимый коммит, который заканчивается
зелёными `npm run typecheck` и `vitest run`, критерием приёмки, который можно
проверить руками или тестом, minor-бампом версии и тегом
`remote-control@<версия>`, отправленным в origin. Этап делегируется следующему
агенту без потери контекста: `PLAN.md` (этот файл) + `__doc.md` (техническая
правда) + `README.md` (английский, лицо плагина).

**Порядок работ заказан заказчиком; соблюдён, с одной ревизией по ходу:**
сначала блок B (терминал ghostty + импорт его настроек), затем секреты
(блок C), затем вызов ssh в терминале плагина (блок D), всё остальное —
блоки E–G. Ревизия: рантайм браузерного терминала (B2–B4) отменён в 0.17.9
(ADR-5/ADR-6) — «терминал в вкладке» теперь даёт сам Paseo; из блока B
остался только B1 (импорт настроек системного ghostty, без рантайма).

---

## 1. Что показали источники (исследование до планирования)

Эти факты определяют архитектуру; их нельзя переоткрывать на этапе кода.

### 1.1 rdp-pilot — это лаунчер, а не RDP-рендерер

Репозиторий: <https://github.com/SirafimsBrain/rdp-pilot>. Фактически один
модуль `__init__.py` (плагин для SSH Pilot): `FreeRdpBackend.build_spawn()`
собирает `SpawnSpec(argv=..., env=...)`, а запуск и окно делает хост.

- **Бинарий:** `RDP_PILOT_BIN` (override) → при `WAYLAND_DISPLAY`:
  `wlfreerdp3, xfreerdp3, wlfreerdp, xfreerdp`; иначе `xfreerdp3, wlfreerdp3,
  xfreerdp, wlfreerdp`. Поиск через `shutil.which`, в Flatpak — через
  `flatpak-spawn --host`.
- **Версия определяется по окончанию имени бинаря на `3`**, иначе считается
  FreeRDP 2; для v2 код конвертирует опции (`/cert:ignore`→`-cert-ignore`,
  `/kbd:layout:`→`-kbd:`, `/gateway:`→`/g:` и т.д.).
- **Аргументы** (всегда argv-массив, не shell-строка):
  `/v:<host>:<port>`, `/u:`, опционально `/t:` (заголовок = никнейм
  подключения), `/d:`, `/p:<password>`; дальше группы —
  дисплей (`+dynamic-resolution`, `/size:`|`/f`, `/bpp:`, `/workarea`,
  `/multimon`), производительность (`+fonts`/`-fonts`, `+aero`,
  `+window-drag`, `+menu-anims`, `-themes`, `-wallpaper`, `/gdi:`),
  перенаправление (`+clipboard` по умолчанию, `+drives`, `+home-drive`,
  `/printer`, `/smartcard`, `/serial:`), звук (`/sound`, `/audio-mode:0|1`,
  `/microphone`), безопасность (`/sec:rdp|tls|nla|ext`, `/cert:ignore`,
  `/cert:name:`), шлюз (`/gateway:g:,u:,d:,p:`), клавиатура
  (`/kbd:layout:,type:`), сеть/кодеки (`/network:`, `-compression`, `/rfx`,
  `/nsc`, `/jpeg`, `/jpeg-quality:`).
- **Секреты** лежат в ключах вида `rdp_password_<id>`,
  `rdp_gateway_password_<id>` через `ctx.secrets`; есть legacy-миграция
  plaintext-пароля из `connection.data`.
- **Картинка не передаётся в UI вообще:** FreeRDP рисует в собственном
  нативном окне. Никакого framebuffer-слоя, ввода мыши/клавиатуры, SSE/WebSocket
  в проекте нет.
- Пароль попадает в argv (`/p:`) — известная уязвимость, в README описана как
  known issue; stdin-передача заявлена, но не реализована.
- Тесты — `tests/test_rdp_pilot.py` (валидация, host/port/IPv6, сборка argv,
  discovery, секреты): **это семантический набор тестов для порта**.

### 1.2 vnc-pilot — тоже лаунчер

Репозиторий: <https://github.com/SirafimsBrain/vnc-pilot>. Один модуль
`__init__.py`: `VncBackend.build_spawn()` → `SpawnSpec`, реальное подключение
делает установленный viewer.

- Дефолтный порт 5900; цель формируется как `host:display` (display
  приоритетнее порта), `host:port`, `host::port` для CLI, `vnc://host:port`
  для KRDC/Vinagre; IPv6 в скобках; валидация: пустой хвост, ведущий `-`,
  пробелы, порт 1–65535.
- **Discovery viewers**: TigerVNC, TurboVNC, TightVNC, RealVNC, Remmina, KRDC,
  Vinagre, `gvncviewer`, Custom — с кэшем 30 с и фингерпринтом версии
  (общий бинарь `vncviewer` без фингерпринта отвергается).
- **argv-билдеры per viewer**: TigerVNC `-PreferredEncoding`, TurboVNC
  `-Encoding` (quality 0–9 → `q*10+5`, 1–100), TightVNC `-encodings`,
  RealVNC, Remmina (пароль в профиль `.remmina` 0600), KRDC/Vinagre/gvncviewer
  (пароль не передаётся — пинтент viewer'а), Custom (`extra_args` через
  `shlex.split`).
- **Пароль VNC:** усечение до 8 символов + `vncpasswd -f` → временный файл
  0600, в argv пароль не попадает; временные файлы чистятся на `deactivate()`
  и по exit.
- Тоже **нет** framebuffer-слоя, ввода, стриминга — `encoding`/`quality`/`color
  depth` это просто опции командной строки viewer'а.
- Тесты — `tests/test_vnc_pilot.py` (цели, discovery, argv всех viewer'ов,
  пароли, cleanup): источник ожидаемого поведения для порта.

### 1.3 orca PR #1001 — импорт настроек Ghostty, а не рантайм терминала

<https://github.com/stablyai/orca/pull/1001> — «One-shot Ghostty config
import»: `src/main/ghostty/{discovery,parser,mapper,index}.ts` (+ тесты) и
рендерер-модалка `GhosttyImportModal.tsx` + `useGhosttyImport.ts`. Поток:
найти конфиг Ghostty в стандартных путях → распарсить → замапить
поддерживаемые ключи → показать preview-дифф → применить после подтверждения.
Часть маппингов вырезана ревью (`scrollback-limit`, `window-padding-color`,
`window-padding-balance`, `selection-word-chars`).

**Вывод для плана:** точка входа №1 (как и требовалось для импорта настроек) —
это ровно схема *discovery → parser → mapper → preview → apply*. Рантайм
терминала в этом PR отсутствует.

### 1.4 «libghostty-vt + Canvas2D» — это coder/ghostty-web

<https://github.com/coder/ghostty-web>, npm `ghostty-web@0.4.0`, **MIT**,
«Ghostty for the web with xterm.js API compatibility»:

- WASM-парсер из исходников Ghostty (собранный патчем
  `patches/ghostty-wasm-api.patch`, `zig build lib-vt
  -Dtarget=wasm32-freestanding`) — т.е. и есть `libghostty-vt`;
- рендер — **Canvas2D** (`CanvasRenderer`, dirty-строки, cursor/selection,
  scrollback, DPR), без внешних зависимостей, ~400 КБ WASM;
- **важно для сборки:** в ESM-бандле пакета WASM зашит как
  `data:application/wasm;base64,...` (`new URL(..., self.location)`), отдельный
  ассет подавать не нужно — esbuild просто несёт его в бандл;
- API: `init()`, `Terminal`, `FitAddon`, `onData`/`write`/`resize` —
  миграция с xterm.js = смена импорта;
- демо-сервер (`npx @ghostty-web/demo@next`) использует loopback-токен,
  `/ws` и запрещает cross-origin handshake; вход — сырые строки, `resize` —
  JSON-сообщение.

**Вывод:** стек «libghostty-vt + Canvas2D» закрывается пакетом
`ghostty-web` в веб-консоли плагина; свой WASM-сборкой Zig не занимаемся.

### 1.5 Ограничения Paseo, подтверждённые в этом репо

- Клиентский код плагина — React Native: **DOM/canvas/WebGL/DOM-библиотеки
  запрещены** (импорт-границы SDK, tsconfig без DOM). Значит консоль с терминалом
  — отдельное веб-приложение на loopback, открываемое в workspace browser
  (`navigation.openBrowser`, фолбэк `openExternalUrl`) — **ADR-1 luck-planner**,
  bunny-search открывает своё web-UI так же. Вкладки Paseo: встроить webview в
  нативную панель нельзя.
- `openBrowser` присутствует только на Electron-хостах и может бросить
  исключение — фолбэк и гвард обязательны (`client/open-console.ts` по образцу
  `luck-planner/client/open-dashboard.ts`).
- Host-SDK даёт `spawnProcess`, `execCommand`, `terminateProcess` из
  `@getpaseo/plugin/server` — управление процессами делаем ими, не голым
  `child_process`, где это возможно. **Факт 0.18.10:** внешние окна rdp/vnc
  и вызовы `gpg` идут через `node:child_process` напрямую — нужны detached-процесс
  GUI-окна и stdin-канал для пароля; возврат к `spawnProcess` имеет смысл, только
  если он поддержит оба режима (вопрос для этапов E/F).
- **Из памяти агентов (memory-flash, `remote-control` в базе отсутствует —
  тема новая):**
  - живой install ловит три ловушки (#10): серверный код транспилируется в
    CommonJS (`import.meta.url` пуст → нужен helper с фолбэком на `__dirname`);
    файлы плагина лежат не рядом с исполняемым модулем (путь —
    `$PASEO_HOME/config.json → plugins["<id>"].path`, перезаписывается ~36 мс
    после готовности); опубликованные entry должны быть **копией**, не симлинком
    на ревизию;
  - workspace browser не даёт «прокрасившихся» скриншотов и принимает только
    известные query-строки на `/assets/*` — проверки через DOM/JS (#7);
  - нативную панель нельзя пушить — только request/response RPC и поллинг (#5);
    live-обновления в web-консоли идут SSE (дашборд luck-planner — рабочий
    прецедент);
  - теги пересоздавать нельзя, только `fetch --tags --force` + обычный push (#6).

---

## 2. Решения (ADR)

| # | Решение | Обоснование |
|---|---------|-------------|
| **ADR-1** | **Две поверхности.** (1) Веб-консоль — отдельное веб-приложение (React+TS) на HTTP-сервере плагина, `127.0.0.1`, открывается в workspace browser Paseo (`navigation.openBrowser` → `openExternalUrl`). (2) Тонкая нативная RN-панель «Remote Control»: статус хранилища, список подключений с запуском (ssh → вкладка, rdp/vnc → внешнее окно), кнопка «Open console», плюс ⌘K-пункт. | Терминал живёт во вкладке Paseo (ADR-5), потому что клиентский код плагина — React Native без DOM/canvas (§1.5), а консоль остаётся веб-страницей; требование заказчика «вкладка консоль» реализуется веб-вкладкой; модальные окна в веб-консоли разрешены, главный интерфейс остаётся лаконичным (левое меню + контент, детали — в модалках). |
| **ADR-2** | **Loopback только, с токеном.** Бинд строго `127.0.0.1`, пер-инсталляционный токен доступа (в query для страниц и REST, в `Authorization` для REST), обязательная проверка `Origin`/`Host` на WS и мутациях отменена вместе с WS-мостом (0.17.9), `GET /health` без токена. Никакого `0.0.0.0` и никакого удалённого доступа. | Прямое требование заказчика («только локальный хост») + прецедент ADR-9 luck-planner (пер-инстанс токен, precedence API-ключей memory-flash). Консоль умеет запускать процессы и читать секреты — токен обязателен на каждом вызове. |
| **ADR-3** | **Хранилище разделено на три части:** подключения и группы → SQLite `$PASEO_HOME/plugins/remote-control/remote-control.db` (`node:sqlite`, WAL, `busy_timeout`, `meta.schema_version`); секреты → `pass`-стор в `$PASEO_HOME/pass-store` (переопределение через `PASSWORD_STORE_DIR`, как в примере заказчика); сессии → **в памяти демона** (живут ровно столько, сколько живёт плагин). | Формат passwordstore.org обязателен; SQLite — прецедент luck-planner/memory-flash (один файл, миграции, FTS не нужен); сессии — процессное состояние, на диск его не выгружаем. Секретов в SQLite нет ни в каком виде. **Часть «сессии» отменена в 0.17.9:** реестра сессий в памяти плагина больше нет — терминалы владеет даэмон Paseo, внешние окна rdp/vnc (0.18.10) плагин не трекает. |
| **ADR-4** | **Хранилище открывается один раз.** Сервис `vault` в daemon-процессе: `unlock(masterPassword)` проверяет пароль пробной дешифровкой и кэширует passphrase в памяти; дальше все чтения/записи идут через `--pinentry-mode loopback --passphrase-fd` **без повторных запросов**; `lock()` обнуляет буфер и убивает gpg-agent хранилища; авто-`lock()` в cleanup входной точки плагина (останов демона / disable / update) + досрочно по кнопке Lock в консоли. | Требование заказчика: «открывается один раз мастер паролем… закрывается при остановке демона или принудительно». Асимметрия passwordstore.org сохраняется: изолированный `GNUPGHOME=$PASEO_HOME/pass-gnupg` + ключ, создаваемый плагином при первой настройке; в настройках — опция указать свой существующий ключ (решение заказчика). Passphrase в памяти — осознанный компромисс: альтернатива (pinentry на каждый вызов) нарушает главное требование; обнуление при lock + отсутствие логов — обязательны. |
| **ADR-5** | **Терминал = терминал Paseo во вкладке рабочей области (0.17.9).** Плагин вызывает `paseo.terminals.create({ workspaceId, cwd?, name?, command?, args? })`: даэмон поднимает PTY, а приложение само открывает для него вкладку (`addMissingEntityTabs` в `workspace-layout-actions.ts` открывает вкладку для каждого «сиротского» терминала без вкладки). Своего PTY, рендерера и моста ввода/вывода в плагине больше нет. | Это и есть требуемый заказчиком «терминал в вкладке как в Orca»: host-owned PTY + терминальная view во вкладке. Рендерить терминал в консоли нельзя (клиентский код — React Native без DOM/canvas, §1.5), а ghostty как приложение не встраивается в чужую вкладку; Paseo уже владеет и PTY, и вкладкой. |
| **ADR-6** | **Транспорт терминала — отменён (0.17.9).** Мост `/term` (WS, спайк A3) и адаптеры `server/transport.ts` / `console/src/transport.ts` удалены вместе с браузерным терминалом: ввод/вывод PTY идёт между даэмоном Paseo и его же приложением, плагин в этот поток не встраивается. | Спайк A3 доказал, что WS в workspace browser работает (см. `__doc.md` § Transport, история), но сам терминал теперь живёт во вкладке Paseo, а не в веб-странице консоли — транспорт стал ненужным. |
| **ADR-7** | **SSH: `ssh` запускается внутри терминала Paseo**, argv собирается из профиля подключения (`server/protocols/ssh.ts`). Ключевые данные: identity-файл из хранилища материализуется в `$PASEO_HOME/run/<session>/id` (0600), пароль — через `SSH_ASKPASS`-хелпер (секрет не попадает ни в argv, ни в переменные окружения процесса-вызывающего). Так как запрос на создание терминала не умеет передавать `env`, запуск идёт как `sh -c '<обёртка>'`: обёртка экспортирует `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`/`DISPLAY`, выполняет экранированный argv, удаляет каталог сессии и выходит с кодом ssh. | Требование «вызов ssh клиента в терминале». argv/env — то, что видит `ps`/`/proc`; askpass-канал устраняет обе утечки и переиспользует уже готовый vault; обёртка закрывает отсутствие `env` в API создания терминала. |
| **ADR-8** | **RDP — точный перенос rdp-pilot, FreeRDP 3 только.** Свои discovery (`xfreerdp3`/`wlfreerdp3` + override `REMOTE_CONTROL_RDP_BIN`), конструктор argv (таблицы опций §1.1) и секреты из vault; **v2-fallback, конвертеры опций и Flatpak-обвязка не переносятся**. Сессия = дочерний процесс с нативным окном FreeRDP, трекается в реестре сессий (kill/reconnect/exit-code), а не рисуется в консоли. | Решение заказчика: точный перенос протестированной базы. Заявленный «перенос из Python» = перенос семантики argv/validation/discovery (и его pytest-набора), а не изобретение framebuffer-конвейера. **Статус 0.18.10 — минимальный лаунчер:** `server/protocols/external.ts` ищет по PATH только `xfreerdp3`/`xfreerdp`, пароль идёт через `/from-stdin:force` (никакого `/p:`, argv чист), `/cert:ignore` с переопределением через `payload.cert`, запуск — detached-окном из RPC панели, stderr-хвост попадает в `paseo plugin logs`. **Не сделано (остаётся E1/E3):** discovery с override и `wlfreerdp*`, таблица опций §1.1, поля RDP в модалке, трекинг окна в реестре (реестр отменён ADR-11), gateway-пароль. |
| **ADR-9** | **VNC — точный перенос vnc-pilot.** Discovery viewer'ов с фингерпринтом версии и кэшем, argv-билдеры per viewer, форматирование цели (`host:display` / `host::port` / `vnc://` / IPv6), пароль через `vncpasswd -f` → 0600-временный файл в `$PASEO_HOME/run/` с обязательной уборкой, в argv пароль не попадает. Сессия = процесс viewer'а, трекается как RDP. | Как ADR-8; особенно важен жизненный цикл временных файлов (в оригинале чистятся на deactivate/exit — у нас это cleanup плагина + окончание сессии). **Статус 0.18.10 — минимальный лаунчер:** `vncpasswd -f` → 0600-файл с уборкой по выходу окна, env-фолбэк `VNC_PASSWORD`/`VNC_USERNAME` без `vncpasswd`, последний фолбэк — интерактивный диалог viewer'а. **Не сделано (остаётся F1/F3):** discovery с фингерпринтом, билдеры per viewer, трекинг сессий; на целевой машине VNC-клиент не установлен — живого запуска ещё не было. |
| **ADR-10** | **Реестр протоколов.** `shared/protocols.ts` — zod-схема полей протокола + `defaultPort` + capabilities; `server/protocols/registry.ts` — `buildLaunch(ctx)`/`discover()`. SSH реализует интерфейс первым (блок D), RDP (E) и VNC (F) подключаются без изменения ядра консоли: модалка подключения рисует поля из схемы протокола. | Прямое требование «в перспективе будет расширение протоколов удалённого доступа» — новый протокол = один модуль + запись в реестре, без правок консоли. **Факт 0.18.10:** внешний запуск rdp/vnc идёт мимо `buildLaunch` — RPC `connections.launch` направляет не-ssh в `protocols/external.ts`; `launchable: false` для rdp/vnc сохранён, поскольку флаг означает «запуск во вкладке-терминале». |
| **ADR-11** | ~~Реестр сессий~~ **Отменён в 0.17.9.** Единый реестр сессий (`server/sessions.ts`) и события `session-updated` в SSE удалены вместе с PTY-слоем: у плагина больше нет своих сессий — терминалами владеет даэмон Paseo (список/kill — вид «Terminals»), внешние окна rdp/vnc (0.18.10) живут как detached-процессы без реестра. | Отмена следует из ADR-5: если PTY и вкладка — сторонние, реестр сессий плагину не нужен; kill/reconnect для ssh — это kill терминала Paseo. |
| **ADR-12** | **Живые обновления:** web-консоль подписывается на `GET /api/events` (SSE); нативная панель поллингом дергает RPC `remote-control.state` (push в RN недоступен). Смена настроек/статуса хранилища/сессий шлёт событие всем подписчикам. | Рабочий прецедент memory #5: change-feed luck-planner. Здесь источник событий один (daemon), поэтому достаточно in-process event emitter'а, без таблицы-шины. **Факт 0.18.10:** SSE-поток (`/api/events`) жив, но шлёт только heartbeat — самих событий ещё нет; консоль и панель обновляются поллингом каждые 3 с (change-feed — отдельный этап). |
| **ADR-13** | **Настройки плагина** живут в SQLite (`settings`) и правятся веб-консолью (экран «Settings»); нативная вкладка настроек (`addWorkspacePanel`, locations `["workspace"]`) содержит статус, «Open console» и кнопки vault setup/unlock/lock, чтобы не дублировать UI. Факт 0.18.10: в UI вынесены только статус хранилища и импорт ghostty (экран Settings); кнопки vault живут во вкладке Secrets и в нативных панелях/экране; порт (сервер всегда на ephemeral-порту), путь стора и override-бинарии в UI не вынесены. | Требование «управление всеми параметрами и состоянием плагина во вкладке консоль». |
| **ADR-14** | **Креды и запуск из панели (0.18.10).** Пароль подключения вводится при создании/редактировании и живёт в vault под `connections/<id>/password` (в БД и ответах API — только имя секрета); master-password запрашивается только при закрытом/не созданном хранилище, ошибка — до создания записи. Запуск — из правой панели: ssh → вкладка Paseo (отказ при закрытом vault), rdp/vnc → внешнее окно detached-процессом: FreeRDP читает пароль со stdin (`/from-stdin:force`), TigerVNC — из 0600-файла `vncpasswd -f` (фолбэк — env `VNC_PASSWORD`/`VNC_USERNAME`). Кнопки создания «голого» терминала (консоль, обе панели, ⌘K) удалены. **Ревизия 0.19.10:** мастер-пароль в формах подключения больше не вводится — инициализация и разблокирование происходят один раз в правой панели (группы видны только после открытия хранилища), HTTP-маршруты `vault/setup|unlock|lock` и `/api/secrets*` удалены (404 с подсказкой), ручное создание секретов запрещено; закрытое хранилище → сохранение пароля подключения отклоняется с ошибкой, указывающей на панель. | Требования заказчика 2026-10-27: хранилище = логин+пароль для протоколов; «открыть терминал» = открыть ssh-сессию во вкладке; rdp/vnc — внешними окнами из правой панели; креды не должны засвечиваться в `ps`. |

---

## 3. Структура каталогов

> **Сверено с фактом 2026-10-27 (0.18.10).** Дерево ниже — исходный
> **целевой** план; текущий код от него отличается:
>
> - **удалены** (0.17.9, ADR-5/ADR-6): `server/transport.ts`,
>   `server/sessions.ts`, `server/pty.ts`, `server/prebuilds/`,
>   `shared/sessions.ts`, `console/src/terminal.ts`, `console/src/transport.ts`;
>   `server/askpass.ts` не создавался (askpass-хелпер — внутри
>   `server/protocols/ssh.ts`); React-структура консоли
>   (`console/src/app.tsx`, `views/`, `modals/`, `terminal/`) не создавалась —
>   консоль это `console/index.html` + один vanilla-модуль `console/src/main.ts`;
> - **не созданы** (остаются этапами E/F): `server/protocols/freerdp.ts`,
>   `vnc.ts`, `discovery.ts` — минимальный лаунчер rdp/vnc сейчас в одном
>   `server/protocols/external.ts`;
> - **есть фактически, но в целевом дереве не указаны:** `server/module-dir.ts`,
>   `server/terminals.ts` (TerminalService, ADR-5), `client/console-screen.tsx`,
>   `client/console-settings-panel.tsx` (это и есть «settings-screen»),
>   `client/web.ts`, `shared/vault.ts` (zod-статус),
>   тесты `tests/{terminals,connections-password,external-launch,http-server,ghostty-config,open-console,store,vault}.test.ts`;
> - **сирота:** `client/console-sidebar-item.tsx` нигде не импортируется
>   (`addSidebarItem` не вызывается) — удалить или подключить отдельным этапом;
> - `index.client.tsx` фактически: две панели + screen + один ⌘K-пункт
>   («Open remote-control console») + heartbeat RPC; slash-команд нет;
> - `shared/rpc.ts` = state, vault.*, console-url, connections.list,
>   connections.launch; RPC вида `sessions.*` не существует;
> - `client/settings-screen.tsx` → фактическое имя `console-settings-panel.tsx`.

```text
remote-control/
├── paseo-plugin.json        # id: remote-control, requirements.paseo >=0.11.0,
│                            # build: [["npm","ci"],["npm","run","bundle"]]
├── package.json             # scripts: bundle (console), typecheck, test
├── tsconfig.json            # + vitest.config.mts
├── index.client.tsx         # нативная панель, ⌘K, settings screen, slash-команды
├── index.server.ts          # RPC, жизненный цикл HTTP/WS/SSE, cleanup (lock vault, kill sessions)
├── shared/                  # zod-контракты, без Node/DOM
│   ├── rpc.ts               # defineRpc: state, vault, console-url, sessions
│   ├── connections.ts       # группы и подключения (иерархия, валидация)
│   ├── protocols.ts         # реестр протоколов: ssh | rdp | vnc (+ будущие)
│   ├── sessions.ts          # модель сессии и события
│   ├── vault.ts             # статус хранилища, имена секретов
│   ├── console-api.ts       # контракты REST/SSE консоли
│   └── ghostty-settings.ts  # импортированные настройки ghostty (маппинг)
├── server/
│   ├── store.ts             # SQLite: groups, connections, settings, meta
│   ├── http-server.ts       # SPA + REST + SSE + /health, токен и Origin-guard
│   ├── http-lifecycle.ts    # старт/стоп из настроек (debounce/restart)
│   ├── transport.ts         # адаптер WS (→ фолбэк SSE+POST), результат спайка A3
│   ├── paths.ts             # резолв установочного каталога: import.meta.url → __dirname → config.json plugins[].path  (память #10)
│   ├── vault.ts             # pass-сервис: setup/unlock/lock/status, gpg loopback, PASS/GNUPGHOME env
│   ├── sessions.ts          # реестр: launch/kill/reconnect, события
│   ├── pty.ts               # node-pty: spawn, кольцевой буфер, attach/resize
│   ├── askpass.ts           # SSH_ASKPASS-канал (stage D4)
│   ├── ghostty-config.ts    # discovery → parser → mapper (по orca #1001)
│   └── protocols/
│       ├── registry.ts
│       ├── ssh.ts           # argv + launch в PTY
│       ├── freerdp.ts       # перенос rdp-pilot (FreeRDP 3 only)
│       ├── vnc.ts           # перенос vnc-pilot
│       └── discovery.ts     # бинарии FreeRDP/viewer: PATH, override, кэш, фингерпринт
├── client/
│   ├── console-panel.tsx    # нативная панель (статус + список подключений с запуском + Open console)
│   ├── open-console.ts      # openBrowser → openExternalUrl (чистый модуль, как open-dashboard.ts)
│   └── settings-screen.tsx
├── console/                 # веб-приложение (отдельный бандл, НЕ импортируется из client/server)
│   ├── index.html
│   └── src/
│       ├── app.tsx          # shell: левое меню + контент + модалки
│       ├── api.ts / transport.ts
│       ├── views/{sessions,connections,secrets,terminal,settings}.tsx
│       ├── modals/          # create/edit connection, group, secret, preview импорта
│       └── terminal/        # ghostty-web: mount, fit, theme, attach/resize
├── scripts/bundle.mjs       # esbuild: dist/console/*
├── tests/                   # vitest: store, vault, argv-билдеры, http, sessions, pty
├── README.md                # English (правила проекта)
├── __doc.md                 # English, техническая правда
└── PLAN.md                  # этот файл
```

Импорт-границы SDK: `console/` не импортируется ни из `client/`, ни из
`server/` — он собирается отдельным entry и только раздаётся HTTP-сервером
(прецедент `dist/dashboard` luck-planner).

---

## 4. Модель данных (эскиз)

```sql
-- Группы: произвольная иерархия (adjacency list)
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

-- Подключения: протокол определяет набор полей в payload
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,   -- NULL = корень списка
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('ssh','rdp','vnc')),
  host TEXT NOT NULL,
  port INTEGER,                       -- NULL → defaultPort протокола (22/3389/5900)
  username TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}', -- zod-валидируется схемой протокола
  secret_refs TEXT NOT NULL DEFAULT '{}', -- {"passwordSecret":"connections/<id>/password", ...} — только имена записей pass
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX connections_group ON connections(group_id, sort_order);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);  -- port, auto_lock_s, bin overrides, last_open_view
CREATE TABLE meta     (key TEXT PRIMARY KEY, value TEXT);  -- schema_version
```

Секреты (формат passwordstore.org, каталог — `$PASEO_HOME/pass-store`,
переопределяется `PASSWORD_STORE_DIR`):

```text
$PASEO_HOME/pass-store/
├── .gpg-id                              # recipient = ключ плагина (или указанный пользователем)
└── remote-control/
    ├── connections/<id>/password.gpg    # пароль подключения (0.18.10, создаётся формой)
    ├── <имя>/identity.gpg               # ssh private key (опционально)
    └── <произвольные имена>.gpg          # записи, заведённые руками во вкладке Secrets
$PASEO_HOME/pass-gnupg/                  # изолированный GNUPGHOME плагина
$PASEO_HOME/run/term_<uuid>/             # id-файл 0600 + askpass-хелпер ssh (удаляются обёрткой при выходе ssh)
$PASEO_HOME/run/ext_<uuid>/              # vncpasswd-файл внешнего окна (удаляется при выходе окна)
```

---

## 5. Контракты

### 5.1 RPC (нативная панель / ⌘K)

```text
remote-control.state             → { consoleUrl, listening, version,
                                     vault: {initialized, unlocked, entries} }
remote-control.vault.setup       → { generated: boolean }   // создаёт ключ при первом запуске
remote-control.vault.unlock      → { ok }                    // { password }
remote-control.vault.lock        → { ok }
remote-control.console-url       → { url }                   // с токеном, для openBrowser
remote-control.connections.list  → { connections: [{id, name, protocol, host,
                                     port, username, hasPassword}] }   // 0.18.10, панель
remote-control.connections.launch→ ({connectionId, workspaceId}) →
                                     {kind:"terminal", terminalId, name}   // ssh → вкладка
                                   | {kind:"external", pid, binary}        // rdp/vnc → окно
// Факт: sessions/groups в state нет (лишнее) — они идут своими RPC/маршрутами.
```

### 5.2 REST консоли (все маршруты, кроме `/health`, требуют токен)

```text
GET  /health                    { ok, server, version }   (без токена)
GET  /                        SPA + статика dist/console (fallback — HTML-заглушка)
GET  /api/state               { ok, listening }          (факт: vault/groups нет — они в RPC state и по своим маршрутам)
GET  /api/events              SSE: только heartbeat ": …" (события — отдельный этап, ADR-12)

GET  /api/vault/status        статус для экрана Settings (единственный vault-маршрут)
# /api/vault/setup|unlock|lock и /api/secrets* — удалены в 0.19.10:
# инициализация/разблокировка только в панели (RPC vault.*),
# секреты — только через подключения

GET|POST /api/groups          PATCH|DELETE /api/groups/:id
GET|POST /api/connections     PATCH|DELETE /api/connections/:id
                              POST/PATCH принимают {password} (0.19.10: masterPassword убран):
                              непустой password — сохранить/заменить, "" — удалить секрет,
                              отсутствие поля — не трогать; хранилище закрыто или не создано
                              → 400 с указанием на панель, до создания записи

GET  /api/terminals?workspaceId=…      POST /api/terminals    POST /api/terminals/:id/kill
GET  /api/ghostty/import      preview   POST /api/ghostty/import (apply)

# /api/sessions* — отменены в 0.17.9 вместе с реестром сессий (ADR-11)
# Открытый дефект (найден при сверке 0.18.10): кнопка Apply в Settings шлёт
# POST /api/ghostty/import/apply, а сервер принимает только POST /api/ghostty/import → 404
```

### 5.3 Открытие терминала

```text
Панель (0.18.10): RPC remote-control.connections.launch → terminals.open() на сервере → вкладка;
  прямой paseo.terminals.create остался только в серверном коде; ⌘K «Open terminal» удалён (0.18.10)
Консоль (REST, требует токен):
  GET  /api/terminals?workspaceId=…        → { terminals: [{id, workspaceId, cwd, name, kind, connectionId, startedAt}] }
  POST /api/terminals                      { workspaceId?, connectionId?, cwd?, name? } → 201 { terminal }
  POST /api/terminals/:id/kill             → { ok: true }
Вкладку для терминала открывает само приложение Paseo (см. ADR-5).
```

---

## 6. Атомарные этапы

Каждый этап: `npm run typecheck` + `vitest run` зелёные, бамп версии по
`AGENTS.md` (новая функциональность — +1 вторая цифра с сохранением третьей,
0.17.10 → 0.18.10; багфикс/правки — +1 третья), анонсированный тег
`remote-control@<версия>` в origin. Этапы блоков A–C можно делегировать
разным агентам: границы — файлы.

**Сверено с фактом 2026-10-27. Фактическая линейка тегов** (плановые версии
ниже исторически заняты и для новых этапов не действительны):
`0.1.0` A1, `0.2.0` A2, `0.3.0`+`0.3.1` A3, `0.4.1` B1, `0.5.1` B2, `0.7.0` B3+B4 одним тегом, `0.10.0` C1–C3 одним тегом, `0.15.0` D1–D5 одним
тегом, `0.15.1`–`0.15.6` патчи установки, `0.15.7`/`0.15.8`/`0.15.9`/`0.16.9` —
работы над панелью и консолью (этапов в плане нет; E1-в-0.16.0 не случился),
`0.17.9` — ADR-5 rewrite, терминал-вкладка (тега `0.17.0` не существует),
`0.17.10` — heartbeat RPC в клиенте, `0.18.10` — ADR-14,
`0.19.10` — ревизия ADR-14 (хранилище-основа, без ручных секретов).
**Следующий этап — с `0.20.0`; версии E1…G3 в заголовках этапов ниже —
исторические.**

### Блок A — Фундамент и снятие рисков

**A1. Каркас плагина** → `0.1.0`
- `paseo plugin init remote-control` по конвенциям репо:
  `paseo-plugin.json` (`id: remote-control`, `requirements: {paseo: ">=0.11.0"}`),
  `package.json` (devDeps `@getpaseo/plugin@0.13.0`, `zod`, `react`,
  `react-native`, `vitest`, `esbuild`, `typescript`), `tsconfig.json`,
  `vitest.config.mts`, пустые `index.client.tsx`/`index.server.ts` с cleanup.
- Приёмка: typecheck/tests зелёные; `paseo plugin install <путь>` →
  `paseo plugin ls` = `running`, `paseo plugin logs remote-control` без ошибок.

**A2. Loopback-сервер консоли + открытие во вкладке** → `0.2.0`
- `server/http-server.ts` + `http-lifecycle.ts`: `127.0.0.1`, случайный
  пер-инстанс токен, `GET /health`, раздача SPA-заглушки `console/dist`.
- `server/paths.ts` — резолв каталога установки (`import.meta.url` →
  `__dirname` → `$PASEO_HOME/config.json` → `plugins["remote-control"].path`)
  и публикация ассетов **копией**, не симлинком (урок памяти #10).
- Клиент: `client/open-console.ts` (`openBrowser` → `openExternalUrl`, гвард
  только http/https, throw хоста не теряет URL), нативная панель с кнопкой и
  двумя строками статуса (поллинг RPC), ⌘K-пункт, `remote-control.console-url`.
- Приёмка: тесты опенера (по образцу `tests/open-dashboard.test.ts`) + живой
  HTTP: `/health` отвечает, страница открывается в workspace browser Paseo,
  запрос без токена → 401.

**A3. Спайк транспорта в workspace browser** → `0.3.0`
- Проверить на живом хосте: WebSocket из вкладки Paseo к серверу плагина
  (echo + binary-фреймы + Origin-guard), затем SSE как запасной путь.
- Результат фиксируется в `__doc.md` (§ Transport) и в `server/transport.ts`
  (адаптер с единственной реализацией-победителем и заглушкой второй).
- Приёмка: e2e-тест «страница → сервер → страница» в реальном workspace
  browser (проверки через DOM/JS, не скриншот — память #7), плюс
  unit-тест адаптера; решение «WS или SSE+POST» записано с датой и условиями.

### Блок B — Терминал ghostty (первый по порядку заказчика)

> **Статус 0.17.9:** этапы B2–B4 (вышли 0.5.1 и 0.7.0) заменены: браузерный
> рантайм терминала (`ghostty-web` + Canvas2D), PTY-слой `node-pty` и
> WS-мост `/term` вычищены, терминал открывается вкладкой Paseo (ADR-5,
> ADR-6). B1 (импорт настроек системного ghostty) остаётся без рантайма.

**B1. Импорт настроек системного Ghostty** → `0.4.0`
- `server/ghostty-config.ts` по схеме orca #1001: `discovery` (пути
  `~/.config/ghostty/config`, XDG_CONFIG_HOME, `ghostty/config`), `parser`
  (комменты, `key = value`, включённые файлы — минимум), `mapper`
  (таблица поддерживаемых ключей: font family/size, palette/theme colors,
  cursor style/blink, scrollback, window padding — с явным списком
  неподдерживаемых, как в PR).
- Консоль: экран Settings + модалка preview-диффа «найдено в системе → что
  применится» с кнопкой Apply (и кнопкой «не импортировать»). Результат —
  `shared/ghostty-settings.ts`, складывается в `settings`.
- Приёмка: юнит-тесты discovery/parser/mapper на фикстурах (реальный файл
  конфига + пустой случай «ghostty не установлен» → состояние «не найдено»);
  маппинг неподдерживаемого ключа попадает в список ignored, а не теряется.

**B2. Рантайм терминала: `ghostty-web` + Canvas2D** → `0.5.0`
- `console/src/terminal/`: `await init()`, `new Terminal(...)`, `FitAddon`,
  монтирование в контейнер вкладки, тема/шрифт из настроек B1, курсор,
  выделение, resize по ResizeObserver.
- `scripts/bundle.mjs` проверяет, что WASM уезжает в бандл (data-URL, §1.4) и
  не требуется отдельный ассет.
- Приёмка: тест сборки (`npm run bundle` → ассеты на месте, бандл содержит
  `ghostty-web`), юнит-тест маппинга настроек → опций `Terminal`, ручная
  проверка в консоли: терминал рисует баннер, переживает resize окна и смену
  светлой/тёмной темы Paseo.

**B3. PTY-слой и мост ввода/вывода** → `0.6.0`
- `server/pty.ts`: spawn `$SHELL` через `node-pty` (решение по R2: вариант с
  prebuild против `node-gyp` проверяется установкой в чистый префикс),
  кольцевой буфер вывода (N КиБ) для `attach`, `resize`, kill, события
  `exit` → реестр сессий.
- `server/transport.ts` + `console/src/terminal/`: протокол §5.3,
  auth по токену + Origin, `attach` по `sessionId` → переживает закрытие и
  перезагрузку вкладки.
- `sessions.ts`: первые типы `local` в реестре.
- Приёмка: e2e «открыл вкладку → ввёл `echo` → виден вывод → перезагрузил →
  вывод и процесс живы → kill → событие `session-updated`; unit-тесты буфера
  и протокола (бинарь/JSON-фреймы не путаются).

**B4. Управление локальными сессиями в консоли** → `0.7.0`
- Вид «Sessions»: таблица (тип, заголовок, состояние, PID, started/ended,
  exit code), действия kill / reconnect / open-в-терминал, подписка на SSE.
- Приёмка: два процесса параллельно, kill одного не трогает другой,
  reconnect поднимает новый PID с сохранением истории в буфере; нативная
  панель показывает актуальное число живых сессий (поллинг RPC).

### Блок C — Хранилище секретов (второе по порядку заказчика)

**C1. Сервис хранилища `pass`** → `0.8.0`
- `server/vault.ts`: разметка каталогов (`$PASEO_HOME/pass-store`,
  `$PASEO_HOME/pass-gnupg`), `PASSWORD_STORE_DIR` по примеру заказчика,
  `setup()` — генерация ключа плагина + запись `.gpg-id` (однократно, либо
  выбор пользовательского ключа из настроек), `unlock()/lock()/status()`.
- Non-interactive decryption: `--batch --pinentry-mode loopback --passphrase-fd`
  через `execFile('pass', …)`/`gpg`; passphrase кэшируется в памяти до `lock()`.
  **Спайк-проверка внутри этапа:** если `pass` не прокидывает loopback-опции в
  вызовы — переход на прямые операции `gpg` над файлами стора (тот же формат,
  `pass` остаётся совместимым), интерфейс сервиса не меняется.
- `lock()` в cleanup `index.server.ts` (останов демона/disable/update) +
  убийство gpg-agent изолированного `GNUPGHOME`.
- Приёмка: тесты на временном `GNUPGHOME`/сторе с реальным `gpg`
  (skip, если gpg отсутствует): setup → unlock верным паролем → N подряд идущих
  чтений **без повторного запроса** → lock → следующее чтение падает с
  «locked» → неверный пароль не кэшируется; логи не содержат passphrase.

**C2. UI секретов в консоли** → `0.9.0`
- Вид «Secrets»: список записей (только имена и дата), модалки
  создания/редактирования/просмотра (значение по кнопке, копирование),
  удаление с подтверждением, кнопка **Lock** и индикатор состояния
  (locked/unlocked) в шелле консоли и в нативной панели.
- Приёмка: «открыть один раз» видно вживую — после unlock любые операции над
  секретами идут без диалога пароля; lock мгновенно блокирует следующее
  чтение во всех видах.
- **Статус (факт 0.19.10):** вид «Secrets» и ручное управление секретами
  **отменены** — секретами управляют только формы подключения; кнопки
  setup/unlock/lock остались в нативной панели/экране (RPC `vault.*`).

**C3. Отказоустойчивость и границы хранилища** → `0.10.0`
- Сценарии: сбой `gpg`/отсутствие `pass` в PATH (понятная ошибка в консоли,
  плагин остаётся работоспособным), стор не инициализирован, чужой
  `PASSWORD_STORE_DIR` из настроек, авто-блокировка по таймауту (настройка,
  по умолчанию выключена), обнуление passphrase-буфера (unit-тест на
  буфер-представлении).
- Приёмка: таблица сценарных тестов закрыта; `paseo plugin logs` без утечки
  чувствительных данных на любом из путей.

### Блок D — Модель подключений и SSH (третье по порядку заказчика)

**D1. Модель подключений + реестр протоколов** → `0.11.0`
- `shared/connections.ts` (группы/подключения, иерархия, валидация),
  `shared/protocols.ts` + `server/protocols/registry.ts`, зеркальная схема
  SQLite (§4) в `server/store.ts` с `schema_version` и миграциями.
- Только схема и хранилище — UI и launcher'ы в следующих этапах.
- Приёмка: тесты store на реальном файле (создание, повторный open,
  иерархия 3 уровней, каскад архивации/удаления, move между группами),
  валидация протокола/порта/IPv6/homе со спецсимволами.

**D2. Консоль: группы и подключения** → `0.12.0`
- Вид «Connections»: дерево групп (создать/переименовать/переместить/удалить),
  список подключений в группе, модалка создания/редактирования (имя, группа,
  протокол, host/port/user + поля из схемы протокола, ссылки на секреты),
  поиск, действие «Launch» пока disabled для неподдержанных протоколов.
- Приёмка: e2e-сценарий «создал группу → вложил подгруппу → создал подключение
  → отредактировал → переместил → удалил»; главный вид остаётся лаконичным,
  всё детальное — в модалках (требование заказчика).

**D3. Запуск ssh в терминале плагина** → `0.13.0`
- `server/protocols/ssh.ts`: argv из профиля
  (`ssh -p <port> [-o …] <user>@<host>`, ключевые опции из `payload`),
  запуск внутри PTY (`server/pty.ts`), привязка сессии к connectionId,
  кнопка Launch в консоли → вкладка терминала открывается с этой сессией.
- Приёмка: на живом ssh-хосте (или локальном `sshd` в тестовом окружении)
  подключение устанавливается; argv покрыт юнит-тестами (IPv6, порт,
  экранирование); сессия видна в списке с типом `ssh`.
- **Пересмотрено в 0.17.9:** запуск идёт через `paseo.terminals.create` +
  обёртка `sh -c` (ADR-7), `server/pty.ts` и реестр сессий удалены, кнопка
  Launch открывает вкладку Paseo; юнит-тесты argv — `tests/terminals.test.ts`.

**D4. Учётные данные SSH из хранилища** → `0.14.0`
- Identity: извлечение `identity.gpg` → `$PASEO_HOME/run/<session>/id` 0600
  (chmod проверяется тестом), `-i` + `-o IdentitiesOnly=yes`, удаление файла
  при exit/kill/cleanup.
- Пароль: `SSH_ASKPASS`-канал (`server/askpass.ts`) — хелпер спрашивает
  секрет у плагина по loopback с токеном сессии (`SSH_ASKPASS_REQUIRE=force`),
  секрет не попадает в argv/env; fallback — интерактивный ввод в терминале.
- Приёмка: секрет не виден в `ps`/`/proc/<pid>/cmdline` (тест на аргументы
  spawn), файл ключа исчезает после сессии, разблокированное хранилище не
  запрашивает пароль повторно, заблокированное → понятная ошибка в терминале.
- **Пересмотрено (факт):** `server/askpass.ts` не создавался — askpass-хелпер
  это статический скрипт 0700 в каталоге сессии (`createAskpassHelper` в
  `protocols/ssh.ts`), печатающий секрет напрямую; loopback-HTTP между ssh и
  плагином не нужен. Поведение при закрытом vault уточнено в 0.18.10: при
  наличии сохранённого пароля запуск **отказывается** с явной ошибкой (а не
  «ошибка в терминале»); без сохранённого пароля — интерактивный ввод в вкладке.

**D5. Reconnect и статусы SSH-сессий** → `0.15.0`
- Reconnect (повторный launch того же профиля с новым PID, старый
  репорт закрывается), фильтр сессий по протоколу/подключению, показ
  `lastError` и exit-кода в консоли.
- Приёмка: kill → reconnect → новый PID; упавший по сети ssh помечается
  `exited` с кодом; нативная панель отражает изменения через поллинг.
- **Статус (факт):** выполнено в `0.15.0` и **частично отменено в 0.17.9**
  вместе с реестром сессий (ADR-11): reconnect/lastError/фильтры исходных
  сессий удалены; kill теперь — это kill терминала Paseo из вида «Terminals».

### Блок E — RDP (перенос rdp-pilot, только FreeRDP 3)

> **Статус 0.18.10 — частично:** лаунчер готов в минимальном виде
> (`server/protocols/external.ts`): PATH-поиск `xfreerdp3`/`xfreerdp`, пароль
> через `/from-stdin:force` (argv чист, `/cert:ignore` с переопределением через
> `payload.cert`), detached-окно из RPC панели, stderr-хвост в
> `paseo plugin logs`. **Остаётся E1–E3:** discovery с override и `wlfreerdp*`,
> полная таблица опций §1.1, поля RDP в модалке, gateway-пароль, трекинг окна
> (реестр отменён ADR-11 — kill только вручную), живое подключение к xrdp.
> Версии заголовков этапов (0.16.0/0.17.0/0.18.0) заняты — переназначаются с 0.19.0.

**E1. Discovery FreeRDP 3 + конструктор argv** → `0.16.0`
- `server/protocols/discovery.ts` (PATH + override `REMOTE_CONTROL_RDP_BIN`,
  только `xfreerdp3`/`wlfreerdp3` — v2-кандидаты и Flatpak-обвязка не
  переносятся) и `server/protocols/freerdp.ts` — полная таблица опций §1.1
  в виде argv-массива.
- Перенос pytest-набора rdp-pilot: валидация host/port, встроенный порт,
  IPv6 в `/v:`, порядок групп опций, `/t:` из имени подключения,
  `/sec:`, `/cert:`, `/gateway:`, `/kbd:`, дефолты дисплея/производительности.
- Приёмка: тесты — построчное сравнение argv с эталонами из Python-тестов;
  ни одна ветка v2-конверсий не существует в коде (grep-тест).

**E2. Секреты RDP и запуск сессии** → `0.17.0`
- Пароли RDP/gateway берутся из vault (`secret_refs`), секрет **не** пишется
  в argv: спайк внутри этапа — поддержка FreeRDP 3 `/from-stdin`
  (проверка на `xfreerdp3 --help`); если не поддерживается — `/p:` c
  зафиксированным в `__doc.md` caveat (как в оригинале) и включением по
  настройке.
- Запуск через `spawnProcess`, трекинг в реестре сессий (kind `rdp`),
  `kill` = `terminateProcess`, окно FreeRDP закрывается вместе с процессом.
- Приёмка: живое подключение к тестовому RDP-серверу (xrdp/virtualized),
  процесс виден в консоли с exit-кодом после закрытия окна; секрет не
  встречается в argv процесса (тест).

**E3. Поля RDP в консоли** → `0.18.0`
- Zod-схема полей RDP (display, bpp, security, cert, gateway, kbd, clipboard,
  sound, drives, network/codec) в `shared/protocols.ts`, модалка подключения
  рисует их из реестра, дефолты — как в rdp-pilot.
- Приёмка: параметры из модалки действительно доходят до argv (тест
  «форма → launch»), каждая группа опций покрыта; консоль по-прежнему
  лаконичная (расширенные поля — в свёрнутой секции модалки).

### Блок F — VNC (перенос vnc-pilot)

> **Статус 0.18.10 — частично:** запуск внешнего окна готов (`external.ts`):
> `vncviewer`/`xtigervncviewer` по PATH, пароль через `vncpasswd -f` →
> 0600-файл с уборкой по выходу окна, env-фолбэк `VNC_PASSWORD`/`VNC_USERNAME`
> (без `vncpasswd`), последний фолбэк — интерактивный диалог viewer'а.
> **Остаётся F1–F3:** discovery с фингерпринтом, билдеры per viewer, усечение
> пароля до 8 символов (сейчас не делается), поля VNC в модалке, трекинг
> сессий. На целевой машине VNC-клиент не установлен — живого запуска ещё не
> было. Версии заголовков (0.19.0–0.21.0) переназначаются с 0.19.0 вверх.

**F1. Discovery viewer'ов + argv-билдеры** → `0.19.0`
- `discovery.ts`: TigerVNC/TurboVNC/TightVNC/RealVNC/Remmina/KRDC/Vinagre/
  `gvncviewer`/Custom, фингерпринт версии (общий `vncviewer` без фингерпринта
  отвергается), кэш 30 с; `protocols/vnc.ts`: форматирование цели
  (`host:display`, `host::port`, `vnc://`, IPv6) + билдеры per viewer
  (включая quality-конверсию TurboVNC и `extra_args`).
- Перенос pytest-набора vnc-pilot (цели, валидации, argv каждой опции).
- Приёмка: argv-тесты эталон-в-эталон; валидация «ведущий `-` / пробелы /
  порт вне 1–65535» отклоняется с теми же сообщениями.

**F2. Пароль VNC и запуск сессии** → `0.20.0`
- `vncpasswd -f` → временный файл 0600 в `$PASEO_HOME/run/<session>/`,
  усечение до 8 символов с предупреждением; уборка файла на exit/kill и в
  cleanup плагина; профильные файлы (Remmina) — так же, 0600.
- Запуск viewer'а, трекинг (kind `vnc`), kill/reconnect.
- Приёмка: тест жизненного цикла (файл создан → применён → удалён, прав нет
  утечки после cleanup); живой запуск против локального VNC-сервера.

**F3. Поля VNC в консоли** → `0.21.0`
- Схема полей (клиент, view-only, fullscreen, shared, encoding, quality,
  compress, color depth, extra args), модалка подключения, Launch.
- Приёмка: «форма → argv» тесты; отсутствующие у выбранного viewer'а опции
  не попадают в argv (как в оригинале) и видимы в preview запуска.

### Блок G — Доведение консоли и приёмка

**G1. Единый вид «Sessions» для всех типов** → `0.22.0`
- Все kind'ы в одной таблице, фильтры (тип/подключение/состояние), группировка
  по подключению, live-обновления по SSE, массовые действия, «open» для
  ssh/local и «focus window»-подсказка для rdp/vnc.
- Приёмка: одновременно local+ssh+rdp+vnc сессии; kill/reconnect каждого типа;
  обновления приходят без перезагрузки вкладки.
- **Статус (факт):** вид «Sessions» заменён видом «Terminals» (терминалы Paseo:
  список + kill, поллинг 3 с); единый реестр всех kind отменён (ADR-11).
  Фильтры/группировка/массовые действия и «focus window»-подсказки не
  делались, rdp/vnc окна не отслеживаются — пересмотреть после E/F.

**G2. Настройки плагина** → `0.23.0`
- Экран Settings в консоли: порт/статус сервера, авто-блокировка хранилища,
  путь стора (`PASSWORD_STORE_DIR`), override-бинарии RDP/VNC, размер
  буфера вывода PTY, импорт настроек ghostty (кнопка из B1) и «Lock now».
- Нативный `addSettingsScreen` — только статус и «Open console».
- Приёмка: изменение порта перезапускает сервер (debounce, как
  `http-lifecycle` luck-planner), смена стора применяется без рестарта
  демона, все изменения видны в `GET /api/state`.
- **Статус (факт 0.18.10):** частично — экран Settings консоли: JSON-статус
  хранилища + импорт ghostty; кнопки vault — во вкладке Secrets и нативных
  панелях/экране. Не вынесено в UI: порт (сервер всегда на ephemeral-порту),
  путь стора, override-бинарии, размер буфера PTY (PTY в плагине больше нет);
  перезапуск по смене порта не применим, пока порт не редактируется.

**G3. Документация и команды** → `0.24.0`
- `README.md` плагина (English: что это, установка, экраны, безопасность,
  ограничения), `__doc.md` (English: ADR-1…ADR-13, схема, протоколы,
  результат спайка A3, caveat argv FreeRDP, таблица протоколов), запись в
  корневой `README.md` (одна строка в списке плагинов + строка в таблице
  install/build), slash-команда `/remote` и ⌘К-пункты «Open console»,
  «New connection», «Lock vault».
- Приёмка: ссылки из корневого README ведут на существующие файлы; оба
  документа самодостаточны для следующего агента; typecheck/tests зелёные.
- **Статус (факт 0.18.10):** README/__doc.md/строка корневого README
  актуальны. **Не сделано:** slash-команда `/remote`, ⌘K-пункты «New
  connection» и «Lock vault» (⌘K есть только «Open remote-control console»;
  ⌘K «Open terminal» удалён намеренно в 0.18.10). **Открытый дефект:** кнопка
  Apply импорта шлёт POST /api/ghostty/import/apply, сервер принимает только
  POST /api/ghostty/import → 404 (чинится патчем 0.18.x).

**G4. Приёмочная проверка на живом даэмоне** → без бампа
- Установка из git-источника (`paseo plugin add …:remote-control`), статус
  `running`, `Plugin ready` в логах; чистый `paseo plugin reload`; обе
  entry собираются реальным хост-компилятором; вкладка консоли открывается в
  workspace browser, токен обязателен (WS-мост удалён в 0.17.9 — Origin-guard
  больше неприменим); секреты: setup → unlock → повторные чтения без запроса →
  lock (в т.ч. после остановки демона); ssh-сессия открывается во вкладке Paseo
  с автологином из vault; rdp/vnc поднимаются внешним окном из правой панели;
  импорт настроек ghostty на системе с установленным ghostty и без него.
- Найденные дефекты чинятся патч-этапами с бампом третьей цифры (сейчас это
  `0.18.x`; без новых функций).
- **Статус (факт 0.18.10):** пройдено частично — живые update/reload на даэмоне,
  `running` + `Plugin ready`, `/health` c версией, 401 без токена, ошибочные
  пути хранилища (400 с текстом), CRUD подключений, открытие ssh-вкладки
  (0.17.9–0.18.10). **Не пройдено:** живой ssh-автологин из vault, живые
  RDP/VNC-окна (нет VNC-клиента; окно FreeRDP не поднималось), импорт ghostty
  на системе с/без ghostty, кнопка Apply (см. открытый дефект в G3).

---

## 7. Риски и как они снимаются

| # | Риск | Когда снимается |
|---|------|-----------------|
| **R1** | WebSocket может не работать в workspace browser Paseo | Спайк **A3** закрыл вопрос, но риск отменён в 0.17.9: WS-мост и браузерный терминал удалены |
| **R2** | `node-pty` — нативный модуль: на установке нужен prebuild или toolchain (`install: prebuild.js \|\| node-gyp rebuild`) | Снят в 0.17.9: `node-pty` и `server/prebuilds/` удалены, PTY поднимает даэмон Paseo |
| **R3** | WASM `ghostty-web` и esbuild | Снят в 0.17.9: `ghostty-web` удалён; esbuild собирает только консоль (`npm run bundle`) |
| **R4** | `pass` может не прокидывать loopback-опции gpg → пинтент на каждый вызов | Спайк **внутри C1**; доказанный фолбэк — прямые операции `gpg` над файлами стора (формат идентичен, `pass` совместим) |
| **R5** | Пароль FreeRDP в argv (`/p:`) | **Снят в 0.18.10:** пароль идёт через `/from-stdin:force` → stdin, опции `/p:` в коде нет вовсе; unit-тест держит пароль вне argv. Остаточный риск — регрессии stdin в отдельных версиях FreeRDP (ожидается ≥ 3; upstream #11922/#12048) |
| **R6** | Пути к ассетам и публикация entry на живом install (память #10) | `server/paths.ts` с тремя стратегиями резолва — **A2**, проверяется на живой установке в **G4** |
| **R7** | Нативные окна FreeRDP/viewer наследуют окружение демона (`DISPLAY`/`WAYLAND_DISPLAY`) | Остаётся открытым: живого запуска окна ещё не было (проверяется в живой приёмке E2/F2); отсутствующий бинарь уже даёт явную ошибку, stderr-хвост падения виден в `paseo plugin logs` |
| **R8** | Повторные запросы мастер-пароля (нарушение главного требования) | Целевой тест **C1**: N подряд идущих операций без запроса + авто-lock в cleanup |
| **R9** | Секреты в логах/`ps` | Частично закрыто в 0.18.10: ssh — askpass-скрипт 0700, rdp — stdin, vnc — 0600-файл/env; unit-тесты держат пароли вне argv (`tests/external-launch.test.ts`, `tests/terminals.test.ts`). Остаётся grep-тест логов на живом прогоне |

---

## 8. Версионирование и правила ведения плана

- Новая функциональность — +1 вторая цифра с сохранением третьей
  (`0.17.10` → `0.18.10`), багфикс/правки — +1 третья (`0.18.10` → `0.18.11`),
  релиз по слову «release» — major с обнулением (правила `AGENTS.md`).
  Патч-этапы — третья цифра текущего minor (сейчас `0.18.x`).
- На коммите с бампом — анонсированный тег `remote-control@<версия>` в origin;
  теги не пересоздавать (память #6: `git fetch --tags --force` + обычный push).
- Закрытый этап отмечается в этом файле (галочка + версия + ссылка на раздел
  `__doc.md`), **статусная строка вверху файла обновляется**.
- Технические детали, открытые вопросы и результаты спайков переезжают в
  `__doc.md` (English); `PLAN.md` остаётся картой этапов, `README.md` — лицом.
