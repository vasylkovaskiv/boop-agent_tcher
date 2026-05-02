# Отчет об устранении неполадок деплоя Boop Agent (OVH VPS)

Этот документ суммирует все критические проблемы, возникшие при развертывании
Boop Agent через Docker Compose на сервере OVH, и примененные решения.
Проблемы перечислены в хронологическом порядке их обнаружения.

---

## 1. Отсутствие `convex/_generated/` в Docker-образе

*   **Проблема:** Папка `convex/_generated/` (авто-генерируемые типы клиента Convex)
    была добавлена в `.gitignore` и не попадала в Docker-образ. При запуске контейнер
    падал с ошибкой импорта.
*   **Решение (1-й шаг):** Добавлен шаг `npx convex codegen` прямо в `Dockerfile`.
    Это оказалось нестабильным решением — codegen требует сетевого доступа во время
    сборки.
*   **Решение (финальное):** Папка `convex/_generated/` исключена из `.gitignore`
    и теперь коммитится в репозиторий вместе с остальным кодом.

---

## 2. Отсутствие зависимости `requests` в Whisper-сервисе

*   **Проблема:** `whisper-service` не мог запуститься — в `requirements.txt`
    отсутствовал пакет `requests`, необходимый для работы `faster-whisper`.
*   **Решение:** Пакет `requests` добавлен в `whisper-service/requirements.txt`.

---

## 3. Парсинг инлайн-комментариев в `.env.local`

*   **Проблема:** Docker-парсер `env_file` считывал инлайн-комментарии (текст после `#`)
    как часть значений переменных. Ключи API оказывались повреждены, что вызывало ошибки
    «Invalid API Key» и «503 Service Unavailable».
*   **Решение:** Очищены все инлайн-комментарии из `.env.local`. Все пояснения вынесены
    на отдельные строки.

---

## 4. Отсутствие Claude CLI в Docker-образе

*   **Проблема:** `Claude Agent SDK` использует `ProcessTransport` — он запускает бинарный
    файл `claude` как дочерний процесс. В базовом Node-образе этого бинарника не было,
    поэтому SDK немедленно падал с ошибкой.
*   **Решение:** Добавлена глобальная установка `@anthropic-ai/claude-code` в `Dockerfile`:
    ```dockerfile
    RUN npm install -g @anthropic-ai/claude-code
    ```

---

## 5. Несовместимость модели по умолчанию с AgentRouter

*   **Проблема:** Claude CLI по умолчанию пытается использовать `claude-sonnet-4-x`,
    которая недоступна или имеет другой ID на AgentRouter. Это вызывало ошибки
    инициализации канала (ошибка 503 на уровне API).
*   **Решение:** Создан файл `/home/boop/.claude/settings.json` (внутри образа), который
    принудительно задаёт модель `claude-haiku-4-5-20251001`, отключает телеметрию и
    обновления, необходимые для headless-режима:
    ```json
    {
      "env": {
        "ANTHROPIC_BASE_URL": "https://agentrouter.org/",
        "ANTHROPIC_MODEL": "claude-haiku-4-5-20251001",
        "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_AUTOUPDATER": "1"
      },
      "permissions": { "allow": ["Read(*)", "Write(*)", "Bash(*)"] },
      "askBeforeRunningTool": false
    }
    ```

---

## 6. Преждевременное срабатывание Healthcheck (медленная загрузка модели)

*   **Проблема:** Локальная модель эмбеддингов (`Xenova/bge-large-en-v1.5`, ~440 МБ)
    загружается 30–50 секунд. Docker Healthcheck с настройками по умолчанию убивал
    контейнер раньше, чем сервер успевал полностью запуститься.
*   **Решение:** Увеличен `start-period` до 90 секунд и `retries` до 5.

---

## 7. Петля обновлений Telegram (Crash Loop)

*   **Проблема:** При каждом падении контейнера Telegram накапливал необработанные
    сообщения в очереди. При следующем старте бот получал их все сразу, не успев прогреть
    модель эмбеддингов, и падал снова — образуя бесконечную петлю.
*   **Решение:** В `server/telegram.ts` параметр `drop_pending_updates` для polling
    режима изменён с `false` на `true` — устаревшие сообщения сбрасываются автоматически
    при каждом старте. Webhook-режим оставлен как есть, потому что Telegram сам
    останавливает доставку при повторных ошибках от endpoint'а.

    Если очередь уже забилась и нужна экстренная очистка вручную (без рестарта
    с новым кодом), можно вызвать Telegram API напрямую:
    ```bash
    curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1"
    ```
    Это подтверждает последний update_id, и очередь сбрасывается.

---

## 8. Нехватка оперативной памяти (OOM)

*   **Проблема:** Связка Node.js + модель эмбеддингов (~440 МБ) + subprocess Claude CLI
    потребляла более 3 ГБ ОЗУ, превышая начальный `mem_limit: 2500m`. Контейнер
    завершался без каких-либо явных ошибок в логах (OOM-killer действует тихо).
*   **Диагностика:** Проверка `docker stats` показала, что при загрузке модели потребление
    резко возрастало и упиралось в лимит.
*   **Решение:**
    1.  `mem_limit` для `boop-agent` убран полностью — процесс использует память
        по необходимости в рамках доступных серверу 7.6 ГБ.
    2.  `mem_limit` для `boop-whisper` скорректирован до 4000m (фактическое потребление
        `whisper medium` с `int8` — около 900 МБ).

---

## 9. Tini форвардит SIGTERM от дочерних процессов

*   **Проблема:** `tini` (init-процесс PID 1) пробрасывал SIGTERM, получаемый от
    завершившегося subprocess Claude CLI, основному процессу Node.js. В результате
    контейнер завершался с `ExitCode=0` — без паники, без стектрейса, полностью тихо.
    Флаг `tini -s` проблему не решил.
*   **Диагностика:** Добавлены обработчики `process.on('SIGTERM', ...)` в `env-setup.ts`,
    которые показали: SIGTERM приходит **сразу после** получения сообщения от пользователя.
*   **Решение:** `tini` полностью удалён из `Dockerfile`. Node.js запускается напрямую
    как PID 1 и корректно управляет своими дочерними процессами.

---

## 10. Claude CLI отказывается работать от `root` — Критическая проблема ✦

*   **Проблема:** Это была корневая причина всех сбоев при обработке сообщений.
    Claude Code CLI **отказывается** выполнять флаг `--dangerously-skip-permissions`
    (который SDK передаёт через `permissionMode: "bypassPermissions"`) если процесс
    запущен от пользователя `root`. Контейнеры Docker по умолчанию запускаются именно
    от `root`. Ошибка в stderr:
    ```
    --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
    ```
    Claude CLI завершался с `exit code 1` — SDK бросал исключение, `tini`/npm убивали
    Node процесс. Цикл повторялся при каждом сообщении.
*   **Диагностика:** Ручная проверка: `docker run ... claude --permission-mode bypassPermissions -p hello`
    немедленно воспроизвела ошибку.
*   **Решение:** В `Dockerfile` создан непривилегированный пользователь `boop` (UID 1001).
    Все файлы приложения и конфигурация Claude (`settings.json`) перенесены в его домашнюю
    директорию. Контейнер запускается от этого пользователя:
    ```dockerfile
    RUN groupadd --gid 1001 boop \
     && useradd --uid 1001 --gid boop --create-home boop \
     && chown -R boop:boop /app
    USER boop
    ```

---

## 11. (Не реализовано) YouTube-выжимки

Fork-фича `boop-agent-new` пробует извлекать транскрипты YouTube через
`youtube-transcript-api` + `yt-dlp` с консент-cookies — на дата-центровых IP
это работает нестабильно, потому что YouTube агрессивно блокирует подобные
запросы без личных cookies авторизованного аккаунта. В этом репо фича
**намеренно не подключена**, чтобы не утяжелять Docker-образ python/yt-dlp/Deno
для функциональности, которая на VPS работает плохо.

Если захочешь её добавить позже, в `boop-agent-new` лежит работающий референс:
`server/youtube-tools.ts` (MCP-инструмент `get_transcript`),
`scripts/generate-yt-cookies.mjs` (генератор анонимных consent-cookies),
и правки `Dockerfile`/`docker-compose.yml` для python зависимостей. Описание
трейд-оффов ниже сохранено как опорный материал.

### Попытка 1: npm-пакет `youtube-transcript`

**Задача:** При получении YouTube-ссылки в боте — автоматически спавнить агента,
который скачивает транскрипт и возвращает структурированную выжимку.

### Попытка 1: npm-пакет `youtube-transcript`

*   **Описание:** Установлен npm-пакет `youtube-transcript`. Создан MCP-сервер
    `boop-youtube` с инструментом `get_transcript`, подключённым ко всем
    execution agents.
*   **Ошибка:**
    ```
    [YoutubeTranscript] 🚨 Transcript is disabled on this video (MneQa2ZtnNo)
    ```
    Пакет возвращал ошибку даже для видео с включёнными субтитрами.
*   **Причина:** YouTube блокирует простые HTTP-запросы без cookies с IP
    дата-центров (OVH, Hetzner и т.д.). Npm-пакет не умеет обходить эту защиту.

### Попытка 2: `yt-dlp` (Python) без JS-рантайма

*   **Описание:** `youtube-transcript` удалён. В `Dockerfile` установлен `python3`,
    `pip`, и `yt-dlp`. Переписан `youtube-tools.ts` для вызова `yt-dlp` через
    `execFile`.
*   **Ошибка:**
    ```
    WARNING: [youtube] No supported JavaScript runtime could be found.
    ERROR: [youtube] Sign in to confirm you're not a bot.
    ```
*   **Причина:** `yt-dlp` без JS-рантайма не может решить CAPTCHA YouTube.
    Плюс OVH IP сразу попадает под bot-detection.

### Попытка 3: `yt-dlp` + Deno (JS runtime)

*   **Описание:** В `Dockerfile` добавлена установка Deno через официальный
    install-скрипт (`curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh`).
    Deno — рекомендованный JS-рантайм для `yt-dlp` по умолчанию.
*   **Ошибка:** Та же — `Sign in to confirm you're not a bot`.
*   **Причина:** JS-рантайм помогает yt-dlp парсить JavaScript видео-страницы,
    но не решает проблему IP-репутации. Дата-центровые IP требуют cookies
    авторизованного Google-аккаунта.

### Попытка 4: Автоматические consent cookies

*   **Описание:** Написан скрипт `scripts/generate-yt-cookies.mjs`, который
    генерирует анонимные GDPR-consent cookies (`SOCS`, `CONSENT`) путём
    HTTP-запроса к `youtube.com`. Cookie-файл монтируется в контейнер через
    volume, `yt-dlp` передаётся флаг `--cookies`.
*   **Ошибки:**
    1.  Cookie-файл был смонтирован как `:ro` (read-only) → `OSError: Read-only file system`.
        `yt-dlp` пытается перезаписать cookies после сессии. Исправлено убрав `:ro`.
    2.  Ошибка bot-detection осталась — consent cookies без реального Google
        аккаунта (`VISITOR_INFO1_LIVE`, `SID`, `SSID`) недостаточны для
        обхода блокировки с дата-центровых IP.
*   **Почему не стали использовать личные cookies:** Нежелание привязывать
    личный аккаунт Google к серверному процессу.

### Текущий подход: Двойной метод (транскрипт API + yt-dlp)

*   **Описание:** `youtube-tools.ts` переписан с двумя независимыми методами:
    1.  **Primary — `youtube-transcript-api` (Python):** Использует внутренний
        `timedtext` API YouTube напрямую, без cookies. Работает для публичных
        видео с субтитрами (авто или ручными). Вызывается через `execFile python3`
        с инлайн-скриптом.
    2.  **Fallback — `yt-dlp`:** Применяется если первый метод не сработал.
        Поддерживает файл cookies (`/app/youtube-cookies.txt`), который можно
        положить вручную без пересборки контейнера.
*   **Статус:** В процессе тестирования. Оба инструмента установлены в
    `Dockerfile` (`pip3 install yt-dlp youtube-transcript-api`).

### Архитектурные детали реализации

| Компонент | Файл | Роль |
|---|---|---|
| MCP-сервер | `server/youtube-tools.ts` | Инструмент `get_transcript` для агентов |
| Подключение | `server/execution-agent.ts` | `createYouTubeMcp()` в `mcpServers` для всех агентов |
| Промпт диспетчера | `server/interaction-agent.ts` | Детектирует YouTube URL → `send_ack` → `spawn_agent` |
| Генератор cookies | `scripts/generate-yt-cookies.mjs` | Создаёт анонимные cookies (пока недостаточны) |
| Маунт cookies | `docker-compose.yml` | `./youtube-cookies.txt:/app/youtube-cookies.txt` |

### Ключевой вывод

YouTube в 2025 году агрессивно блокирует дата-центровые IP для любых
неавторизованных запросов к субтитрам. Единственный надёжный путь без
личного аккаунта — `youtube-transcript-api`, который использует `/api/timedtext`
напрямую с минимальными HTTP-заголовками. Этот endpoint пока менее защищён,
чем основной video endpoint.

---

## Итоговый статус

Все проблемы 1–10 решены и применены в коде этого репо. Система стабильна:
`restarts=0`, бот отвечает в Telegram, стоимость запросов корректно логируется
(порядка `$0.01–0.04` за turn). Интеграция с AgentRouter через
`claude-haiku-4-5-20251001` подтверждена.

**YouTube-выжимки (проблема 11):** В этот репо не интегрированы. Если решишь
вернуть фичу — забирай файлы из `viktoriana565/boop-agent-new` и держи в виду
что без личных cookies авторизованного аккаунта Google запросы с дата-центровых
IP будут блокироваться нестабильно.

---

## 12. Perplexity Pro Search

Reverse-engineered интеграция с `https://www.perplexity.ai/rest/sse/perplexity_ask`
через резидентный прокси и cookies от живого Pro-аккаунта. Код в
`server/perplexity*.ts`, схема — `convex/perplexityState`, `perplexityCache`,
`perplexitySessions`. Всё включается, только если задан `ASOCKS_PROXY_URL`.

### Симптомы и что делать

**`[perplexity] disabled — ASOCKS_PROXY_URL not set`** в логах. Это нормально,
если интеграция намеренно выключена. Чтобы включить — добавь в `.env.local`
`ASOCKS_PROXY_URL=http://USER:PASS@host:port` и перезапусти бот.

**`[perplexity] no cookies in Convex` при первом запросе.** Schema задеплоилась,
но cookies ещё не залиты. Запусти на своей локальной машине (где установлен
Dolphin Anty):
```bash
export CONVEX_URL=<тот же что у бота>
npm run refresh-perplexity-cookies -- --profile-id=<id-Dolphin-профиля>
```
Скрипт упадёт с понятной ошибкой если в профиле нет `__Secure-next-auth.session-token`
— значит профиль не залогинен в Perplexity. Открой Dolphin вручную, залогинься,
повтори.

**`HTTP 401 — cookies expired` или `HTTP 403`.** Cookies протухли (обычно через
5–8 дней). Бот пришлёт алерт в Telegram (`TELEGRAM_ADMIN_CHAT_ID` или первый
из `TELEGRAM_ALLOWED_CHAT_IDS`) и инкрементит `consecutiveFailures` в
`perplexityState`. Лечится тем же `npm run refresh-perplexity-cookies`. Если
после рефреша снова 401 — Dolphin-профиль вышел из Perplexity, нужно
вручную залогиниться там.

**Систематические 403 от Cloudflare сразу после рефреша cookies.** Не cookies
виноваты — TLS-фингерпринт. Установи `cycletls` и включи флаг:
```bash
npm install cycletls
echo 'PERPLEXITY_USE_CYCLETLS=1' >> .env.local
```
Клиент лениво подгружает `cycletls` только когда флаг включён, поэтому
без флага сборка остаётся чистой.

**`HTTP 429 — Pro Search rate limit hit`.** Перси-аккаунт упёрся в дневной
лимит Pro Search (≥300/день). Подожди до следующих суток UTC, переходи на
`mode: "concise"` для простых запросов, или докупай Pro+ план.

**Ответ есть, но без источников / с фразой "I cannot access real-time data".**
Это значит запрос ушёл с `search_focus != "internet"` или с неправильным
`mode`. Проверь `server/perplexity-client.ts` — поле `search_focus: "internet"`
обязательно для Pro Search. Без него Perplexity маршрутизирует запрос в
"writing" режим, где модель видит результаты поиска но получает инструкцию
их игнорировать.

**Worker не зовёт `mcp__perplexity__perplexity_search` несмотря на регистрацию.**
Скорее всего dispatcher не положил `"perplexity"` в массив integrations при
`spawn_agent`. Проверь:
1. В логах сервера должна быть строка `[perplexity] registered`.
2. Skill `.claude/skills/web-research/SKILL.md` должен существовать (worker
   читает skills через `settingSources: ["project"]` в `execution-agent.ts`).
3. `availableIntegrations()` должен возвращать `"perplexity"` (можно
   проверить через debug UI's Connections tab или `/health`).

**Cookies «протухают» каждые ~24 часа вместо ~7 дней.** Скорее всего у тебя
включена двухфакторка на Perplexity-аккаунте, или Dolphin-профиль использует
прокси, отличный от `ASOCKS_PROXY_URL`. Cookies валидируются по IP — если
залил cookies через Dolphin'овский прокси (страна A), а бот стучится через
asocks (страна B), Perplexity это видит и сбрасывает сессию.
Решение: настрой Dolphin-профиль использовать тот же `ASOCKS_PROXY_URL`,
перелогинься, рефрешни cookies.

### Что НЕЛЬЗЯ делать

- **Не запускай `refresh-perplexity-cookies` на VPS.** Dolphin Anty — это
  desktop-приложение для Windows/macOS. Скрипт всегда запускается локально
  у тебя.
- **Не делай параллельные запросы вручную (минуя очередь).** Перси быстро
  банит аккаунты, у которых одни и те же cookies стучатся параллельно с
  разных потоков — это паттерн account sharing.
- **Не коммить `.env.local` или содержимое таблицы `perplexityState`.**
  Cookies приравнены к паролю.
- **Не меняй имя cookie `__Secure-next-auth.session-token` на похожее.**
  Точный регистр и подчёркивание после `__Secure-` критичны. Без правильного
  имени Perplexity молча отдаёт ответ free-tier — никаких ошибок, просто
  деградация качества.
