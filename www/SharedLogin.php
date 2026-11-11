<?php

declare(strict_types=1);

namespace Lem;

use PDO;
use PDOException;

/**
 * Shared login (single sign-on) for the LEM apps. Keep this file identical in the three LEM apps,
 * next to SharedAccounts.php.
 *
 * Browsers send a cookie to every port of the host that set it, so when the apps run on one
 * address (http://10.0.0.5:8000, :8001, :8003 ...) a signed "lem_sso" cookie set by any of them
 * is seen by all of them. Logging in to one app logs you in to the others; logging out of one
 * logs you out of all of them. The signing key and the list of logged-out cookies are stored in
 * the shared account database, so there is nothing to configure.
 *
 * A cookie stops working when it expires (12 hours without using any of the apps), when it is
 * logged out, or when the user's password changes, the user is deleted or must change their
 * password.
 */
final class SharedLogin
{
    public const COOKIE = 'lem_sso';
    public const LIFETIME = 43200;
    /** $_SESSION key: the shared login this app session belongs to. */
    public const SESSION_KEY = 'lem_sso';

    private ?string $secret = null;
    /** @var array{username: string, role: string, stamp: string, sid: string, expires: int}|false|null */
    private array|false|null $current = false;

    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * The shared login of this browser, or null. Keeps it alive (sliding 12 hours) while it is used.
     *
     * @return array{username: string, role: string, stamp: string, sid: string, expires: int}|null
     */
    public function current(): ?array
    {
        if ($this->current !== false) {
            return $this->current;
        }
        $this->current = null;
        $parsed = self::parse();
        if ($parsed === null || $parsed['expires'] <= time() || $parsed['expires'] > time() + self::LIFETIME + 300) {
            return null;
        }
        $row = $this->find($parsed['username']);
        if ($row === null || $row['username'] !== $parsed['username'] || (int) $row['must_change_password'] !== 0) {
            return null;
        }
        $stamp = hash('sha256', $row['password_hash']);
        if (!hash_equals($this->mac($row['username'], $parsed['sid'], $parsed['expires'], $stamp), $parsed['mac'])
            || $this->revoked($parsed['sid'])) {
            return null;
        }
        $login = ['username' => $row['username'], 'role' => $row['role'], 'stamp' => $stamp, 'sid' => $parsed['sid'], 'expires' => $parsed['expires']];
        if ($parsed['expires'] - time() < self::LIFETIME - 600 && !headers_sent()) {
            $login['expires'] = time() + self::LIFETIME;
            $this->send($login['username'], $login['sid'], $login['expires'], $stamp);
        }
        return $this->current = $login;
    }

    /**
     * Start the shared login for a user who has just logged in to this app (call before any output).
     * Users who must still change their temporary password get none. Returns the login id or null.
     */
    public function issue(string $username): ?string
    {
        $row = $this->find($username);
        $old = $this->current();
        if ($row === null || (int) $row['must_change_password'] !== 0) {
            if ($old !== null) {
                $this->end(); // someone else is using this browser now
            }
            return null;
        }
        if (headers_sent()) {
            return null;
        }
        if ($old !== null && $old['username'] === $row['username']) {
            $sid = $old['sid']; // already logged in elsewhere as the same user: keep the other apps logged in
        } else {
            if ($old !== null) {
                $this->revoke($old['sid']);
            }
            $sid = bin2hex(random_bytes(16));
        }
        $expires = time() + self::LIFETIME;
        $stamp = hash('sha256', $row['password_hash']);
        $this->send($row['username'], $sid, $expires, $stamp);
        $this->current = ['username' => $row['username'], 'role' => $row['role'], 'stamp' => $stamp, 'sid' => $sid, 'expires' => $expires];
        return $sid;
    }

    /** Log this browser out of every LEM app. */
    public function end(): void
    {
        $parsed = self::parse();
        if ($parsed !== null) {
            $this->revoke($parsed['sid']);
        }
        if (isset($_COOKIE[self::COOKIE]) && !headers_sent()) {
            setcookie(self::COOKIE, '', ['expires' => time() - 3600] + self::cookieOptions());
        }
        unset($_COOKIE[self::COOKIE]);
        $this->current = null;
    }

    /**
     * For apps using SharedAccounts sessions ($_SESSION['lem_account']): log this app's session in or
     * out to match the shared login. Call after session_start() and before SharedAccounts::user().
     * Returns true when a different user (or nobody) is now signed in.
     */
    public function syncSession(): bool
    {
        $login = $this->current();
        $mine = $_SESSION['lem_account'] ?? null;
        $tied = $_SESSION[self::SESSION_KEY] ?? null;
        if ($login !== null) {
            $same = is_array($mine) && ($mine['username'] ?? null) === $login['username'] && $tied === $login['sid'];
            if (!$same) {
                session_regenerate_id(true);
            }
            $_SESSION['lem_account'] = ['username' => $login['username'], 'stamp' => $login['stamp'], 'expires' => $login['expires']];
            $_SESSION[self::SESSION_KEY] = $login['sid'];
            return !$same;
        }
        if ($tied !== null) { // logged out in another app, expired, or the password changed
            unset($_SESSION['lem_account'], $_SESSION[self::SESSION_KEY]);
            session_regenerate_id(true);
            return true;
        }
        return false;
    }

    /** After SharedAccounts::login() succeeded: share the login with the other apps. */
    public function afterLogin(): void
    {
        $username = $_SESSION['lem_account']['username'] ?? null;
        $sid = is_string($username) ? $this->issue($username) : null;
        if ($sid !== null) {
            $_SESSION[self::SESSION_KEY] = $sid;
            $_SESSION['lem_account']['expires'] = $this->current['expires'] ?? $_SESSION['lem_account']['expires'];
        } else {
            unset($_SESSION[self::SESSION_KEY]);
        }
    }

    /** After SharedAccounts::logout(): log out of the other apps too. */
    public function afterLogout(): void
    {
        unset($_SESSION[self::SESSION_KEY]);
        $this->end();
    }

    /** @return array{username: string, sid: string, expires: int, mac: string}|null */
    private static function parse(): ?array
    {
        $raw = $_COOKIE[self::COOKIE] ?? null;
        if (!is_string($raw) || strlen($raw) > 700) {
            return null;
        }
        $parts = explode('.', $raw);
        if (count($parts) !== 5 || $parts[0] !== '1' || !preg_match('/^[a-f0-9]{32}$/D', $parts[2])
            || !preg_match('/^[0-9]{1,12}$/D', $parts[3]) || !preg_match('/^[a-f0-9]{64}$/D', $parts[4])) {
            return null;
        }
        $username = base64_decode(strtr($parts[1], '-_', '+/'), true);
        if ($username === false || $username === '') {
            return null;
        }
        return ['username' => $username, 'sid' => $parts[2], 'expires' => (int) $parts[3], 'mac' => $parts[4]];
    }

    private function send(string $username, string $sid, int $expires, string $stamp): void
    {
        $value = '1.' . rtrim(strtr(base64_encode($username), '+/', '-_'), '=') . '.' . $sid . '.' . $expires
            . '.' . $this->mac($username, $sid, $expires, $stamp);
        setcookie(self::COOKIE, $value, ['expires' => $expires] + self::cookieOptions());
        $_COOKIE[self::COOKIE] = $value;
    }

    /** @return array{path: string, secure: bool, httponly: bool, samesite: string} */
    private static function cookieOptions(): array
    {
        $https = !empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off';
        return ['path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax'];
    }

    private function mac(string $username, string $sid, int $expires, string $stamp): string
    {
        return hash_hmac('sha256', "1|{$username}|{$sid}|{$expires}|{$stamp}", $this->secret());
    }

    private function secret(): string
    {
        if ($this->secret !== null) {
            return $this->secret;
        }
        try {
            $secret = $this->pdo->query('SELECT secret FROM lem_sso_key WHERE id = 1')->fetchColumn();
        } catch (PDOException) {
            $secret = false; // first use: the tables don't exist yet
        }
        if (!is_string($secret) || strlen($secret) !== 64) {
            $this->pdo->exec('CREATE TABLE IF NOT EXISTS lem_sso_key (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL)');
            $this->pdo->exec('CREATE TABLE IF NOT EXISTS lem_sso_revoked (sid TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
            $this->pdo->prepare('INSERT OR IGNORE INTO lem_sso_key (id, secret) VALUES (1, ?)')->execute([bin2hex(random_bytes(32))]);
            $secret = (string) $this->pdo->query('SELECT secret FROM lem_sso_key WHERE id = 1')->fetchColumn();
        }
        return $this->secret = $secret;
    }

    private function revoked(string $sid): bool
    {
        $stmt = $this->pdo->prepare('SELECT 1 FROM lem_sso_revoked WHERE sid = ?');
        $stmt->execute([$sid]);
        return $stmt->fetchColumn() !== false;
    }

    private function revoke(string $sid): void
    {
        $this->secret(); // makes sure the tables exist
        $now = time();
        $this->pdo->prepare('DELETE FROM lem_sso_revoked WHERE expires <= ?')->execute([$now]);
        $this->pdo->prepare('INSERT OR REPLACE INTO lem_sso_revoked (sid, expires) VALUES (?, ?)')
            ->execute([$sid, $now + self::LIFETIME + 600]);
    }

    /** @return array{username: string, role: string, password_hash: string, must_change_password: int}|null */
    private function find(string $username): ?array
    {
        $stmt = $this->pdo->prepare('SELECT username, role, password_hash, must_change_password FROM users WHERE username = ?');
        $stmt->execute([trim($username)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }
}
