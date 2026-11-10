<?php

declare(strict_types=1);

namespace Lem;

use PDO;
use RuntimeException;

/**
 * Shared account schema v1. Keep this file identical in the three LEM apps.
 * Only the explicit Dashboard migration command may initialize a new store.
 */
final class SharedAccounts
{
    private function __construct(public readonly PDO $pdo)
    {
    }

    public static function open(string $file, bool $initialize = false): self
    {
        if ($file === '' || $file[0] !== '/' || (!$initialize && !is_file($file))) {
            throw new RuntimeException('LEM_AUTH_DB must name an existing absolute database path. Initialize it using Dashboard bin/shared-users.php first.');
        }
        $pdo = new PDO('sqlite:' . $file, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 15,
        ]);
        $pdo->exec('PRAGMA busy_timeout = 15000');
        if ($initialize) {
            $pdo->exec(<<<'SQL'
                CREATE TABLE IF NOT EXISTS lem_auth_schema (version INTEGER PRIMARY KEY);
                INSERT OR IGNORE INTO lem_auth_schema VALUES (1);
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    created TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'lead', 'user')),
                    last_login INTEGER,
                    must_change_password INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS user_profiles (
                    username TEXT PRIMARY KEY COLLATE NOCASE REFERENCES users(username) ON DELETE CASCADE,
                    photo BLOB,
                    photo_mime TEXT NOT NULL DEFAULT '',
                    photo_version TEXT NOT NULL DEFAULT '',
                    theme TEXT NOT NULL DEFAULT 'main'
                );
                CREATE TABLE IF NOT EXISTS lem_auth_throttle (
                    address TEXT PRIMARY KEY,
                    attempts INTEGER NOT NULL,
                    expires INTEGER NOT NULL
                );
                SQL);
        }
        if ($pdo->query('SELECT version FROM lem_auth_schema')->fetchAll(PDO::FETCH_COLUMN) !== [1]) {
            throw new RuntimeException('Unsupported shared account schema; update the LEM apps together.');
        }
        return new self($pdo);
    }

    /** @return array{username: string, role: string, password_hash: string, must_change_password: int}|null */
    private function find(string $username): ?array
    {
        $stmt = $this->pdo->prepare('SELECT username, role, password_hash, must_change_password FROM users WHERE username = ?');
        $stmt->execute([trim($username)]);
        $row = $stmt->fetch();
        return is_array($row) ? $row : null;
    }

    /** @return array{username: string, role: string}|null */
    public function user(): ?array
    {
        $session = $_SESSION['lem_account'] ?? null;
        if (!is_array($session) || !is_string($session['username'] ?? null)
            || !is_string($session['stamp'] ?? null) || (int) ($session['expires'] ?? 0) <= time()) {
            return null;
        }
        $row = $this->find($session['username']);
        if ($row === null || (int) $row['must_change_password'] !== 0
            || !hash_equals(hash('sha256', $row['password_hash']), $session['stamp'])) {
            unset($_SESSION['lem_account']);
            return null;
        }
        return ['username' => $row['username'], 'role' => $row['role']];
    }

    public function login(string $username, string $password, string $address): bool
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            throw new RuntimeException('Start an application-specific session before authenticating.');
        }
        $key = hash('sha256', $address);
        $now = time();
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $this->pdo->prepare('DELETE FROM lem_auth_throttle WHERE expires <= ?')->execute([$now]);
            $stmt = $this->pdo->prepare('SELECT attempts FROM lem_auth_throttle WHERE address = ?');
            $stmt->execute([$key]);
            if ((int) $stmt->fetchColumn() >= 10) {
                throw new RuntimeException('Too many login attempts. Wait five minutes and try again.');
            }
            $this->pdo->prepare('INSERT INTO lem_auth_throttle VALUES (?, 1, ?) ON CONFLICT(address) DO UPDATE SET attempts = attempts + 1')
                ->execute([$key, $now + 300]);
            $this->pdo->exec('COMMIT');
        } catch (\Throwable $e) {
            $this->pdo->exec('ROLLBACK');
            throw $e;
        }
        $row = $this->find($username);
        $hash = $row['password_hash'] ?? '$2y$10$ok5.BF.PDB0EqUKvV2O4qe8unwZ2ROq2fVEFEx5HnEmnzcRG50Vbu';
        if (!password_verify($password, $hash) || $row === null) {
            return false;
        }
        if ((int) $row['must_change_password'] !== 0) {
            throw new RuntimeException('Change your temporary password in LEM-Dashboard before signing in here.');
        }
        $this->pdo->prepare('UPDATE users SET last_login = ? WHERE username = ?')->execute([$now, $row['username']]);
        $this->pdo->prepare('DELETE FROM lem_auth_throttle WHERE address = ?')->execute([$key]);
        session_regenerate_id(true);
        $_SESSION['lem_account'] = [
            'username' => $row['username'],
            'stamp' => hash('sha256', $row['password_hash']),
            'expires' => $now + 43200,
        ];
        return true;
    }

    public function logout(): void
    {
        unset($_SESSION['lem_account']);
        session_regenerate_id(true);
    }
}
