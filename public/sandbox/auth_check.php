<?php
/**
 * Проверка SSO-сессии для canvas (тот же домен, кука auth_session).
 * Node-сервер вызывает этот эндпоинт сервер-к-серверу, передавая cookie.
 * GET /sandbox/auth_check.php  (Cookie: auth_session=...)
 *
 * Отвечает { authenticated: bool, user_id: int|null, is_admin: bool }.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

// Внутренний эндпоинт: только запросы с самого сервера (Node на 127.0.0.1).
// Через nginx REMOTE_ADDR = публичный IP хоста, localhost-запросы дают 127.0.0.1/::1.
$remote = $_SERVER['REMOTE_ADDR'] ?? '';
$serverIps = ['127.0.0.1', '::1', '79.143.31.184'];
$envIps = getenv('CANVAS_SERVER_IPS');
if ($envIps) {
    foreach (explode(',', $envIps) as $ip) {
        $ip = trim($ip);
        if ($ip !== '') {
            $serverIps[] = $ip;
        }
    }
}
if (!in_array($remote, $serverIps, true)) {
    http_response_code(403);
    echo json_encode(['authenticated' => false, 'error' => 'forbidden']);
    exit;
}

require_once __DIR__ . '/AuthClient.php';

$status = AuthClient::checkStatus();
$user = $status['user'];

if ($status['status'] === 'authenticated' && is_array($user)) {
    echo json_encode([
        'authenticated' => true,
        'user_id' => isset($user['id']) ? (int)$user['id'] : null,
        'is_admin' => !empty($user['is_admin']),
        'name' => $user['display_name'] ?? ($user['login'] ?? null),
    ], JSON_UNESCAPED_UNICODE);
} else {
    // Недоступность auth-web трактуем как "не авторизован" на уровне canvas.
    echo json_encode(['authenticated' => false]);
}
