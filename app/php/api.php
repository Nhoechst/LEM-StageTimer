<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $data): never
{
    http_response_code($status);
    echo json_encode($data, JSON_THROW_ON_ERROR);
    exit;
}

function isTime(mixed $value): bool
{
    return (is_int($value) || is_float($value)) && is_finite((float) $value) && $value >= 0;
}

function isId(mixed $value): bool
{
    return is_string($value) && trim($value) !== '';
}

function validLogo(mixed $value): bool
{
    return is_string($value) && ($value === '' || (strlen($value) <= 699116 &&
        preg_match('~^data:image/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$~D', $value)));
}

function textLength(string $value): int
{
    // Match JavaScript's UTF-16 string length, including supplementary characters.
    return preg_match_all('/./us', $value) + preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $value);
}

function validFont(mixed $font): bool
{
    if ($font === null) return true;
    if (!is_object($font) || count((array) $font) !== 2 || !is_string($font->name ?? null) ||
        $font->name === '' || textLength($font->name) > 255 || preg_match('/[\x00-\x1f\x7f]/', $font->name) ||
        !is_string($font->data ?? null) || strlen($font->data) > 699092 ||
        !preg_match('~\Adata:font/(woff2?|ttf|otf);base64,([A-Za-z0-9+/]+={0,2})\z~D', $font->data, $match)) return false;
    $bytes = base64_decode($match[2], true);
    if ($bytes === false || base64_encode($bytes) !== $match[2]) return false;
    $size = strlen($bytes);
    if ($size < 12 || $size > 524288) return false;
    $u16 = fn (int $offset): int => unpack('n', substr($bytes, $offset, 2))[1];
    $u32 = fn (int $offset): int => unpack('N', substr($bytes, $offset, 4))[1];
    $signature = $u32(0);
    if ($match[1] === 'ttf' || $match[1] === 'otf') {
        if ($signature !== ($match[1] === 'ttf' ? 0x00010000 : 0x4f54544f)) return false;
        $count = $u16(4); $end = 12 + $count * 16;
        if (!$count || $count > 256 || $end > $size) return false;
        for ($i = 12; $i < $end; $i += 16) {
            $offset = $u32($i + 8); $length = $u32($i + 12);
            if ($offset < $end || $offset > $size || $length > $size - $offset) return false;
        }
    } else {
        $woff2 = $match[1] === 'woff2'; $header = $woff2 ? 48 : 44;
        if ($size < $header || $signature !== ($woff2 ? 0x774f4632 : 0x774f4646) ||
            !in_array($u32(4), [0x00010000, 0x4f54544f], true) || $u32(8) !== $size ||
            !$u16(12) || $u16(12) > 256 || $u16(14) ||
            $u32(16) < 12 + $u16(12) * 16 || $u32(16) > 8388608) return false;
        if ($woff2) {
            if ($size <= $header + $u16(12) || !$u32(20) || $u32(20) > $size - $header) return false;
        } else {
            $end = $header + $u16(12) * 20;
            if ($end > $size) return false;
            $expanded = 12 + $u16(12) * 16;
            for ($i = $header; $i < $end; $i += 20) {
                $offset = $u32($i + 4); $compressed = $u32($i + 8); $original = $u32($i + 12);
                if ($offset < $end || $offset > $size || $compressed > $size - $offset || $compressed > $original) return false;
                $expanded += (int) ceil($original / 4) * 4;
            }
            if ($expanded !== $u32(16)) return false;
        }
        foreach ($woff2 ? [28, 40] : [24, 36] as $offset) {
            $start = $u32($offset); $length = $u32($offset + 4);
            if (($start === 0) !== ($length === 0) || ($start && $start < $header) || $start > $size || $length > $size - $start) return false;
        }
        if ($u32($woff2 ? 36 : 32) > 8388608) return false;
    }
    return true;
}

function validFonts(object $value): bool
{
    foreach (['timerFont', 'textFont'] as $key) {
        if (property_exists($value, $key) && !validFont($value->$key)) return false;
    }
    return true;
}

function normalizeLogo(object $value, string $logo = 'uploadedLogo', string $name = 'logoName', ?object $previous = null): object
{
    $result = clone $value;
    if ($logo === 'uploadedLogo' && $previous) {
        foreach (['timerFont', 'textFont'] as $key) {
            if (!property_exists($result, $key) && property_exists($previous, $key)) $result->$key = $previous->$key;
        }
    }
    $keys = [$logo, $name, $logo . 'Light', $name . 'Light', $logo . 'Dark', $name . 'Dark'];
    $present = false;
    foreach ($keys as $key) {
        if (property_exists($value, $key) || ($previous && property_exists($previous, $key))) $present = true;
    }
    if (!$present) return $result;
    foreach (array_slice($keys, 2) as $key) {
        if (!property_exists($result, $key) && $previous && property_exists($previous, $key)) $result->$key = $previous->$key;
    }
    $light = $logo . 'Light'; $lightName = $name . 'Light';
    if (empty($result->$light) && !empty($result->$logo) && !($previous && property_exists($previous, $light))) {
        $result->$light = $result->$logo;
        $result->$lightName = $result->$name ?? '';
    }
    foreach (array_slice($keys, 2) as $key) $result->$key = $result->$key ?? '';
    $result->$logo = !empty($result->$light) && !validLogo($result->$light) ? $result->$light : '';
    $result->$name = textLength($result->$lightName) > 255 ? $result->$lightName : '';
    return $result;
}

function validModeLogos(object $value, string $logo, string $name, bool $inherited = false): bool
{
    foreach (['Light', 'Dark'] as $mode) {
        $imageKey = $logo . $mode; $nameKey = $name . $mode;
        if (property_exists($value, $imageKey) && !validLogo($value->$imageKey) &&
            !($inherited && $mode === 'Light' && is_string($value->$imageKey) &&
                $value->$imageKey === ($value->$logo ?? null))) return false;
        if (property_exists($value, $nameKey) && (!is_string($value->$nameKey) ||
            (textLength($value->$nameKey) > 255 && !($inherited && $mode === 'Light' && $value->$nameKey === ($value->$name ?? null))))) return false;
    }
    return true;
}

function validState(mixed $state): bool
{
    if (!is_object($state) || !is_int($state->revision ?? null) ||
        $state->revision < 0 || $state->revision > 9007199254740991 ||
        !is_array($state->shows ?? null) || !is_object($state->settings ?? null) ||
        !is_string($state->settings->pin ?? null) ||
        !preg_match('/^(?:|[0-9]{4,6})$/D', $state->settings->pin)) {
        return false;
    }
    foreach (['mainHeader', 'subHeader', 'headerLogoName'] as $key) {
        if (property_exists($state->settings, $key) && (!is_string($state->settings->$key) ||
            textLength($state->settings->$key) > ($key === 'headerLogoName' ? 255 : 200))) return false;
    }
    if (property_exists($state->settings, 'headerLogo') && !validLogo($state->settings->headerLogo)) return false;
    if (!validModeLogos($state->settings, 'headerLogo', 'headerLogoName')) return false;
    if (property_exists($state, 'templates')) {
        if (!is_array($state->templates) || count($state->templates) > 50) return false;
        $ids = []; $names = [];
        foreach ($state->templates as $template) {
            if (!is_object($template) || !isId($template->id ?? null) ||
                !is_string($template->name ?? null) || trim($template->name) !== $template->name ||
                $template->name === '' || textLength($template->name) > 80 || preg_match('/[\x00-\x1f\x7f]/', $template->name) ||
                !in_array($template->templateId ?? null, ['bayer-light', 'bayer-blue', 'minimal-dark'], true) ||
                !is_bool($template->logoOn ?? null) ||
                (property_exists($template, 'uploadedLogo') && !validLogo($template->uploadedLogo)) ||
                (property_exists($template, 'logoName') && (!is_string($template->logoName) ||
                    textLength($template->logoName) > 255)) ||
                !validModeLogos($template, 'uploadedLogo', 'logoName') || !validFonts($template) ||
                array_diff(array_keys((array) $template), ['id', 'name', 'templateId', 'logoOn', 'uploadedLogo', 'logoName', 'uploadedLogoLight', 'uploadedLogoDark', 'logoNameLight', 'logoNameDark', 'timerFont', 'textFont']) ||
                in_array($template->id, $ids, true)) return false;
            foreach ($names as $name) {
                if (preg_match('/\A(?:' . preg_quote($name, '/') . ')\z/iu', $template->name)) return false;
            }
            $ids[] = $template->id; $names[] = $template->name;
        }
    }
    $showIds = [];
    foreach ($state->shows as $show) {
        if (!is_object($show) || !isId($show->id ?? null) ||
            in_array($show->id, $showIds, true) || !is_string($show->title ?? null) ||
            !is_array($show->cues ?? null) || !isTime($show->left ?? null) ||
            !in_array($show->status ?? null, ['Ready', 'Running', 'Paused', 'Complete'], true) ||
            !is_string($show->templateId ?? null) || !is_bool($show->logoOn ?? null)) {
            return false;
        }
        $showIds[] = $show->id;
        if (!validModeLogos($show, 'uploadedLogo', 'logoName', true) || !validFonts($show)) return false;
        $cueIds = [];
        foreach ($show->cues as $cue) {
            if (!is_object($cue) || !isId($cue->id ?? null) ||
                in_array($cue->id, $cueIds, true) || !is_string($cue->name ?? null) ||
                !isTime($cue->duration ?? null) ||
                (property_exists($cue, 'type') && !in_array($cue->type, ['countdown', 'countup', 'clock'], true)) ||
                (property_exists($cue, 'clockFormat') && !in_array($cue->clockFormat, ['12h', '24h'], true))) {
                return false;
            }
            $cueIds[] = $cue->id;
        }
        foreach (['active', 'uploadedLogo', 'logoName'] as $key) {
            if (property_exists($show, $key) && !is_string($show->$key)) {
                return false;
            }
        }
        if ((property_exists($show, 'blackout') && !is_bool($show->blackout)) ||
            (property_exists($show, 'pinnedAt') && !isTime($show->pinnedAt))) {
            return false;
        }
        if (property_exists($show, 'message')) {
            $message = $show->message;
            if (!is_object($message) || !is_string($message->text ?? null) ||
                !is_object($message->destinations ?? null) ||
                !is_bool($message->destinations->display ?? null) ||
                !is_bool($message->destinations->dsm ?? null) ||
                (property_exists($message->destinations, 'chroma') && !is_bool($message->destinations->chroma)) ||
                (property_exists($message, 'color') && (!is_string($message->color) || !preg_match('/^#[0-9a-fA-F]{6}$/D', $message->color))) ||
                (property_exists($message, 'flash') && !is_bool($message->flash)) ||
                (property_exists($message, 'bold') && !is_bool($message->bold)) ||
                (property_exists($message, 'uppercase') && !is_bool($message->uppercase))) {
                return false;
            }
            // Match the legacy/new message distinction in the browser schema.
            $extended = property_exists($message, 'color') || property_exists($message, 'flash') ||
                property_exists($message, 'bold') || property_exists($message, 'uppercase') ||
                property_exists($message->destinations, 'chroma');
            if ($extended && (textLength($message->text) > 500 || !preg_match('/[^\s\x{FEFF}]/u', $message->text) ||
                !($message->destinations->display || $message->destinations->dsm || ($message->destinations->chroma ?? false)))) {
                return false;
            }
        }
    }
    return true;
}

function cueType(object $show): string
{
    foreach ($show->cues ?? [] as $cue) {
        if ($cue->id === ($show->active ?? null)) return $cue->type ?? 'countdown';
    }
    return 'countdown';
}

function clockAnchor(object $show): float
{
    // The existing deadline column holds the zero origin for a count-up timer.
    return microtime(true) * 1000 + (cueType($show) === 'countup' ? -1 : 1) * $show->left * 1000;
}

function readState(PDO $db): array
{
    $meta = $db->query('SELECT revision, initialized FROM meta WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
    $result = ['initialized' => (bool) $meta['initialized'], 'revision' => (int) $meta['revision']];
    if (!$result['initialized']) {
        return $result;
    }
    $result['shows'] = [];
    $result['timerVersions'] = new stdClass();
    $cues = $db->prepare('SELECT data FROM cues WHERE show_id = ? ORDER BY position');
    foreach ($db->query('SELECT id, metadata FROM shows ORDER BY position') as $row) {
        $show = json_decode($row['metadata'], false, 512, JSON_THROW_ON_ERROR);
        $cues->execute([$row['id']]);
        $show->cues = array_map(
            fn ($json) => json_decode($json, false, 512, JSON_THROW_ON_ERROR),
            $cues->fetchAll(PDO::FETCH_COLUMN)
        );
        $clock = $db->prepare('SELECT deadline FROM timer_clock WHERE show_id = ?');
        $clock->execute([$show->id]);
        $deadline = $clock->fetchColumn();
        $result['timerVersions']->{$show->id} = [
            $show->active ?? null, $show->left, $show->status, $deadline === false ? null : (float) $deadline
        ];
        if ($deadline !== false && $show->status === 'Running' && cueType($show) !== 'clock') {
            $up = cueType($show) === 'countup';
            $show->left = max(0, (int) ($up
                ? floor((microtime(true) * 1000 - (float) $deadline) / 1000)
                : ceil(((float) $deadline - microtime(true) * 1000) / 1000)));
            if (!$up && $show->left === 0) {
                $show->status = 'Complete';
            }
        }
        $result['shows'][] = normalizeLogo($show);
    }
    $result['settings'] = (array) normalizeLogo(json_decode($db->query('SELECT data FROM site_settings WHERE id = 1')->fetchColumn(), false, 512, JSON_THROW_ON_ERROR), 'headerLogo', 'headerLogoName');
    $result['settings']['pin'] = '';
    $result['templates'] = array_map(fn ($data) => normalizeLogo(json_decode($data, false, 512, JSON_THROW_ON_ERROR)),
        $db->query('SELECT data FROM branding_templates ORDER BY position')->fetchAll(PDO::FETCH_COLUMN));
    return $result;
}

function writeState(PDO $db, object $state, int $revision): void
{
    $previous = [];
    foreach ($db->query('SELECT id, metadata FROM shows') as $row) {
        $previous[$row['id']] = json_decode($row['metadata'], false, 512, JSON_THROW_ON_ERROR);
    }
    $clocks = $db->query('SELECT show_id, deadline FROM timer_clock')->fetchAll(PDO::FETCH_KEY_PAIR);
    $db->exec('DELETE FROM cues; DELETE FROM shows;');
    $insertShow = $db->prepare('INSERT INTO shows (id, position, metadata) VALUES (?, ?, ?)');
    $insertCue = $db->prepare('INSERT INTO cues (show_id, id, position, data) VALUES (?, ?, ?, ?)');
    foreach ($state->shows as $position => $show) {
        $metadata = normalizeLogo($show, 'uploadedLogo', 'logoName',
            isset($previous[$show->id]) ? normalizeLogo($previous[$show->id]) : null);
        unset($metadata->cues);
        $command = !isset($previous[$show->id]) || !isset($state->timerCommands) ||
            in_array($show->id, $state->timerCommands, true);
        if (!$command) {
            foreach (['active', 'left', 'status'] as $key) {
                if (property_exists($previous[$show->id], $key)) {
                    $metadata->$key = $previous[$show->id]->$key;
                } else {
                    unset($metadata->$key);
                }
            }
        }
        $insertShow->execute([$show->id, $position, json_encode($metadata, JSON_THROW_ON_ERROR)]);
        if ($metadata->status === 'Running') {
            $db->prepare('INSERT INTO timer_clock VALUES (?, ?)')->execute([
                $show->id, $command ? clockAnchor((object) [...(array) $metadata, 'cues' => $show->cues]) : $clocks[$show->id]
            ]);
        }
        foreach ($show->cues as $cuePosition => $cue) {
            $insertCue->execute([$show->id, $cue->id, $cuePosition, json_encode($cue, JSON_THROW_ON_ERROR)]);
        }
    }
    if ($state->settings->pin !== '') {
        $db->prepare('UPDATE settings SET pin = ? WHERE id = 1')->execute([hashPin($state->settings->pin)]);
    }
    $site = normalizeLogo(json_decode($db->query('SELECT data FROM site_settings WHERE id = 1')->fetchColumn(), false, 512, JSON_THROW_ON_ERROR), 'headerLogo', 'headerLogoName');
    $incoming = normalizeLogo($state->settings, 'headerLogo', 'headerLogoName', $site);
    foreach (['mainHeader', 'subHeader', 'headerLogo', 'headerLogoName', 'headerLogoLight', 'headerLogoDark', 'headerLogoNameLight', 'headerLogoNameDark'] as $key) {
        if (property_exists($incoming, $key)) $site->$key = $incoming->$key;
    }
    $db->prepare('UPDATE site_settings SET data = ? WHERE id = 1')->execute([json_encode($site, JSON_THROW_ON_ERROR)]);
    if (property_exists($state, 'templates')) {
        $previousTemplates = [];
        foreach ($db->query('SELECT id, data FROM branding_templates') as $row) {
            $previousTemplates[$row['id']] = normalizeLogo(json_decode($row['data'], false, 512, JSON_THROW_ON_ERROR));
        }
        $db->exec('DELETE FROM branding_templates');
        $insert = $db->prepare('INSERT INTO branding_templates VALUES (?, ?, ?)');
        foreach ($state->templates as $position => $template) {
            $insert->execute([$template->id, $position, json_encode(normalizeLogo($template, 'uploadedLogo', 'logoName',
                $previousTemplates[$template->id] ?? null), JSON_THROW_ON_ERROR)]);
        }
    }
    $db->prepare('UPDATE meta SET revision = ?, initialized = 1 WHERE id = 1')->execute([$revision]);
}

function backupDatabase(string $filename): void
{
    $staging = $filename . '.bak-next';
    try {
        if (is_link($staging) || is_link($filename . '.bak')) {
            throw new RuntimeException('Database backups must not be symlinks.');
        }
        if (file_exists($staging) && !unlink($staging)) {
            throw new RuntimeException('Unable to clear backup staging file.');
        }
        $backup = new PDO('sqlite:' . $filename, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $backup->exec('PRAGMA busy_timeout = 5000');
        $backup->exec('VACUUM INTO ' . $backup->quote($staging));
        $backup = null;
        if (!chmod($staging, 0600)) throw new RuntimeException('Unable to protect backup permissions.');
        if (!rename($staging, $filename . '.bak')) {
            throw new RuntimeException('Unable to replace backup.');
        }
    } finally {
        if (is_file($staging) && !is_link($staging)) {
            unlink($staging);
        }
    }
}

function hashPin(string $pin): string
{
    $salt = bin2hex(random_bytes(16));
    return 'pbkdf2$210000$' . $salt . '$' . hash_pbkdf2('sha256', $pin, $salt, 210000, 64);
}

function operatorStatus(PDO $db, string $id, string $token): array
{
    $configured = $db->query('SELECT pin FROM settings WHERE id = 1')->fetchColumn() !== '';
    $query = $db->prepare('SELECT 1 FROM operator_sessions WHERE id = ? AND token = ? AND expires > ?');
    $query->execute([$id, hash('sha256', $token), (int) (microtime(true) * 1000)]);
    return ['configured' => $configured, 'authorized' => !$configured || (bool) $query->fetchColumn()];
}

function operatorFail(PDO $db, int $status, string $message): never
{
    $db->exec('ROLLBACK');
    respond($status, ['error' => $message]);
}

function operatorRequest(PDO $db, mixed $payload, string $id, string $token): array
{
    $action = $payload->action ?? '';
    if (!preg_match('/^[a-f0-9]{32}$/D', $id) || !in_array($action, ['bootstrap', 'unlock', 'lock', 'configure'], true)) {
        operatorFail($db, 400, 'Invalid operator request.');
    }
    if ($action === 'bootstrap') {
        operatorCookie($token);
        return operatorStatus($db, $id, $token);
    }
    $now = (int) (microtime(true) * 1000);
    $db->prepare('DELETE FROM operator_sessions WHERE expires <= ?')->execute([$now]);
    $db->prepare('DELETE FROM operator_throttle WHERE expires <= ?')->execute([$now]);
    if ($action === 'lock') {
        $db->prepare('DELETE FROM operator_sessions WHERE id = ?')->execute([$id]);
        $nextToken = $token;
    } else {
        if ($action === 'configure' && !operatorStatus($db, $id, $token)['authorized']) {
            operatorFail($db, 401, 'Enter the PIN to authorize this window first.');
        }
        $pin = $payload->pin ?? null;
        if (!is_string($pin) || !preg_match('/^(?:|[0-9]{4,6})$/D', $pin) || ($action === 'unlock' && $pin === '')) {
            operatorFail($db, 400, 'Use a numeric PIN with 4–6 digits.');
        }
        if ($action === 'unlock') {
            $key = hash('sha256', $_SERVER['REMOTE_ADDR'] ?? '');
            $query = $db->prepare('SELECT attempts FROM operator_throttle WHERE id = ?');
            $query->execute([$key]);
            if ((int) $query->fetchColumn() >= 5) operatorFail($db, 429, 'Too many attempts. Wait one minute before retrying.');
            $db->prepare('INSERT INTO operator_throttle VALUES (?, 1, ?)
                ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1')->execute([$key, $now + 60000]);
            $stored = explode('$', $db->query('SELECT pin FROM settings WHERE id = 1')->fetchColumn());
            if (count($stored) !== 4 || $stored[0] !== 'pbkdf2' || $stored[1] !== '210000' ||
                !hash_equals($stored[3], hash_pbkdf2('sha256', $pin, $stored[2], 210000, 64))) {
                $db->exec('COMMIT');
                respond(401, ['error' => 'That PIN is not correct.']);
            }
            $db->prepare('DELETE FROM operator_throttle WHERE id = ?')->execute([$key]);
        } else {
            $db->prepare('UPDATE settings SET pin = ? WHERE id = 1')->execute([$pin !== '' ? hashPin($pin) : '']);
            $db->exec('DELETE FROM operator_sessions');
        }
        $nextToken = $action === 'configure' ? bin2hex(random_bytes(32)) : $token;
        $db->prepare('INSERT OR REPLACE INTO operator_sessions VALUES (?, ?, ?)')->execute([
            $id, hash('sha256', $nextToken), $now + 43200000
        ]);
    }
    operatorCookie($nextToken);
    return operatorStatus($db, $id, $nextToken);
}

function operatorCookie(string $token): void
{
    if (($_COOKIE['lem_operator'] ?? '') === $token) return;
    setcookie('lem_operator', $token, [
        'expires' => time() + 43200,
        'path' => '/', 'httponly' => true, 'samesite' => 'Strict',
        'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ||
            str_starts_with($_SERVER['HTTP_ORIGIN'] ?? '', 'https://')
    ]);
}

$db = null;
$transaction = false;
try {
    $method = $_SERVER['REQUEST_METHOD'];
    if (!in_array($method, ['GET', 'PUT', 'POST'], true)) {
        header('Allow: GET, PUT, POST');
        respond(405, ['error' => 'Method not allowed.']);
    }
    // JSON writes require a browser Origin matching the requested host (no CORS).
    $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
    if ($origin !== null) {
        $parts = parse_url($origin);
        $authority = is_array($parts) ? ($parts['host'] ?? '') .
            (isset($parts['port']) ? ':' . $parts['port'] : '') : '';
        $scheme = is_array($parts) ? ($parts['scheme'] ?? '') : '';
        if (!in_array($scheme, ['http', 'https'], true) ||
            $origin !== $scheme . '://' . $authority ||
            strtolower($authority) !== strtolower($_SERVER['HTTP_HOST'] ?? '')) {
            respond(403, ['error' => 'Origin not allowed.']);
        }
    } elseif ($method !== 'GET') {
        respond(403, ['error' => 'Origin required for writes.']);
    }

    $payload = null;
    if ($method !== 'GET') {
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
            respond(415, ['error' => 'Content-Type must be application/json.']);
        }
        $limit = 10 * 1024 * 1024;
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) {
            respond(413, ['error' => 'Payload too large.']);
        }
        $body = file_get_contents('php://input', false, null, 0, $limit + 1);
        if ($body === false || strlen($body) > $limit) {
            respond(413, ['error' => 'Payload too large.']);
        }
        try {
            $payload = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            respond(400, ['error' => 'Malformed JSON.']);
        }
        if ($method === 'PUT' && !validState($payload)) {
            respond(400, ['error' => 'Invalid state payload.']);
        }
        if (isset($payload->timerCommands) && (!is_array($payload->timerCommands) ||
            count(array_filter($payload->timerCommands, 'is_string')) !== count($payload->timerCommands))) {
            respond(400, ['error' => 'Invalid timer commands.']);
        }
    }

    // Default stays outside the egg's www, including subdirectory installs.
    if (!extension_loaded('pdo_sqlite')) {
        throw new RuntimeException('Enable pdo_sqlite in the active PHP-FPM configuration and restart PHP-FPM.');
    }
    $filename = getenv('DB_PATH') ?: '/home/container/lem-time-data/lem-time.db';
    if (!str_starts_with($filename, '/') || !str_ends_with($filename, '.db')) {
        throw new RuntimeException('DB_PATH must be an absolute .db path.');
    }
    $directory = dirname($filename);
    umask(0077);
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to create private data directory.');
    }
    $privateRoot = realpath($directory);
    $publicRoot = realpath($_SERVER['DOCUMENT_ROOT'] ?? __DIR__);
    if ($privateRoot === false || $publicRoot === false ||
        $privateRoot === $publicRoot || str_starts_with($privateRoot, $publicRoot . '/') ||
        is_link($filename)) {
        throw new RuntimeException('Database must be outside the web root.');
    }
    $legacy = getenv('STATE_PATH') ?: $directory . '/lem-time.json';
    if (!file_exists($filename) && file_exists($filename . '.bak')) {
        throw new RuntimeException('Database backup found without database. Restore it before continuing.');
    }
    $db = new PDO('sqlite:' . $filename, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    if (!chmod($filename, 0600)) throw new RuntimeException('Unable to protect database permissions.');
    $db->exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    $schemaMissing = (int) $db->query("SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name IN ('meta', 'shows', 'cues', 'settings', 'timer_clock', 'site_settings', 'branding_templates')")->fetchColumn() !== 7;
    $needsMigration = $schemaMissing;
    if (!$schemaMissing) {
        foreach ($db->query('SELECT metadata FROM shows LEFT JOIN timer_clock ON shows.id = timer_clock.show_id
            WHERE timer_clock.show_id IS NULL') as $row) {
            if (json_decode($row['metadata'], false, 512, JSON_THROW_ON_ERROR)->status === 'Running') {
                $needsMigration = true;
                break;
            }
        }
        $needsMigration = $needsMigration ||
            (!(bool) $db->query('SELECT initialized FROM meta WHERE id = 1')->fetchColumn() &&
                (file_exists($legacy) || is_link($legacy) || file_exists($legacy . '.bak')));
    }
    if ($needsMigration) {
        // Recheck under the writer lock so concurrent first accesses import/seed only once.
        $db->exec('BEGIN IMMEDIATE');
        $transaction = true;
        $db->exec("CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, initialized INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS shows (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, metadata TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cues (
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (show_id, id));
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), pin TEXT NOT NULL);
        INSERT OR IGNORE INTO settings VALUES (1, '');");
        $db->exec("CREATE TABLE IF NOT EXISTS site_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
            INSERT OR IGNORE INTO site_settings VALUES (1, '{}');
            CREATE TABLE IF NOT EXISTS branding_templates (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);");
        $db->exec('CREATE TABLE IF NOT EXISTS timer_clock (
            show_id TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE, deadline REAL NOT NULL)');
        $seedClock = $db->prepare('INSERT OR IGNORE INTO timer_clock VALUES (?, ?)');
        foreach ($db->query('SELECT id, metadata FROM shows') as $row) {
            $show = json_decode($row['metadata'], false, 512, JSON_THROW_ON_ERROR);
            if ($show->status === 'Running') {
                $cueRows = $db->prepare('SELECT data FROM cues WHERE show_id = ?');
                $cueRows->execute([$show->id]);
                $show->cues = array_map(fn ($json) => json_decode($json), $cueRows->fetchAll(PDO::FETCH_COLUMN));
                $seedClock->execute([$show->id, clockAnchor($show)]);
            }
        }
        $result = readState($db);
        if (!$result['initialized']) {
            if (is_link($legacy) || (!file_exists($legacy) && file_exists($legacy . '.bak'))) {
                throw new RuntimeException('Restore JSON state from a private regular file before importing.');
            }
            if (file_exists($legacy)) {
                $legacyRoot = realpath(dirname($legacy));
                if (!str_starts_with($legacy, '/') || !is_file($legacy) || $legacyRoot === false ||
                    $legacyRoot === $publicRoot || str_starts_with($legacyRoot, $publicRoot . '/')) {
                    throw new RuntimeException('JSON import must be outside the web root.');
                }
                $json = file_get_contents($legacy);
                if ($json === false) {
                    throw new RuntimeException('Unable to read JSON state for import.');
                }
                $state = json_decode($json, false, 512, JSON_THROW_ON_ERROR);
                if (!is_object($state) || !is_bool($state->initialized ?? null) ||
                    ($state->initialized ? !validState($state) : ($state->revision ?? null) !== 0)) {
                    throw new RuntimeException('Invalid JSON state; import refused without changing saved data.');
                }
                if ($state->initialized) {
                    backupDatabase($filename);
                    writeState($db, $state, $state->revision);
                }
            }
        }
        // Commit migration separately so its saved state is included in write backups.
        $db->exec('COMMIT');
        $transaction = false;
    }
    $db->exec('CREATE TABLE IF NOT EXISTS operator_sessions (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS operator_throttle (
        id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);');
    $oldPin = $db->query('SELECT pin FROM settings WHERE id = 1')->fetchColumn();
    if (preg_match('/^[0-9]{4,6}$/D', $oldPin)) {
        $db->exec('BEGIN IMMEDIATE');
        $transaction = true;
        $oldPin = $db->query('SELECT pin FROM settings WHERE id = 1')->fetchColumn();
        if (preg_match('/^[0-9]{4,6}$/D', $oldPin)) {
            $db->prepare('UPDATE settings SET pin = ? WHERE id = 1')->execute([hashPin($oldPin)]);
            $db->exec('DELETE FROM operator_sessions');
        }
        $db->exec('COMMIT');
        $transaction = false;
    }
    // Established GETs take a consistent read snapshot, not a reserved writer lock.
    $db->exec($method === 'GET' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    $transaction = true;
    $id = $_SERVER['HTTP_X_OPERATOR_ID'] ?? '';
    if (!preg_match('/^[a-f0-9]{32}$/D', $id)) $id = '';
    $token = $_COOKIE['lem_operator'] ?? '';
    if (!preg_match('/^[a-f0-9]{64}$/D', $token)) {
        $token = bin2hex(random_bytes(32));
    }
    if ($method === 'POST') {
        $auth = operatorRequest($db, $payload, $id, $token);
        $db->exec('COMMIT');
        $transaction = false;
        respond(200, ['auth' => $auth]);
    }
    if ($method === 'PUT') {
        if (!operatorStatus($db, $id, $token)['authorized']) {
            operatorFail($db, 401, 'Enter the PIN to authorize this window.');
        }
        if ($payload->settings->pin !== '') operatorFail($db, 400, 'Use operator PIN configuration instead.');
        $revision = (int) $db->query('SELECT revision FROM meta WHERE id = 1')->fetchColumn();
        if ($payload->revision !== $revision || $revision >= 9007199254740991) {
            $db->exec('ROLLBACK');
            $transaction = false;
            respond(409, ['error' => 'State changed. Reload before saving.', 'revision' => $revision]);
        }
        backupDatabase($filename);
        writeState($db, $payload, $revision + 1);
    }
    $result = readState($db);
    $result['auth'] = operatorStatus($db, $id, $token);
    $db->exec('COMMIT');
    $transaction = false;
    respond(200, $result);
} catch (Throwable $error) {
    if ($transaction && $db !== null) {
        $db->exec('ROLLBACK');
    }
    error_log('LEM-Time: ' . $error->getMessage());
    respond(500, ['error' => 'Unable to access saved state. Check PHP-FPM pdo_sqlite support, private data folder permissions, and PHP logs.']);
}
