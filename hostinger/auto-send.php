<?php
/**
 * WhatsApp auto-send webhook for Hostinger.
 * Upload this file to your Hostinger public_html folder.
 *
 * Your webhook URL will be: https://yourdomain.com/auto-send.php
 */

// ─── CONFIG (edit these) ───────────────────────────────────────────
$D360_API_KEY        = '';  // Your 360dialog API key
$WEBHOOK_SECRET      = '';  // Same secret you put in Google Apps Script
$TEMPLATE_NAME       = '';  // Your approved WhatsApp template name
$TEMPLATE_LANG       = 'en';
// ────────────────────────────────────────────────────────────────────

header('Content-Type: application/json');

// Only accept POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// Verify shared secret
$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$token = preg_replace('/^Bearer\s+/i', '', $authHeader);
if (!$token || $token !== $WEBHOOK_SECRET) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// Parse request body
$body = json_decode(file_get_contents('php://input'), true);
$phone = trim($body['phone'] ?? '');
$name  = trim($body['name'] ?? '');

if (!$phone) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing phone']);
    exit;
}

// Clean phone number (strip non-digits)
$cleanPhone = preg_replace('/[^0-9]/', '', $phone);
if (strlen($cleanPhone) < 8) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid phone number']);
    exit;
}

// Build template payload
$template = [
    'name'     => $TEMPLATE_NAME,
    'language' => ['code' => $TEMPLATE_LANG],
];

$payload = [
    'messaging_product' => 'whatsapp',
    'recipient_type'    => 'individual',
    'to'                => $cleanPhone,
    'type'              => 'template',
    'template'          => $template,
];

// Call 360dialog API
$ch = curl_init('https://waba-v2.360dialog.io/messages');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'D360-API-KEY: ' . $D360_API_KEY,
    ],
    CURLOPT_POSTFIELDS     => json_encode($payload),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error    = curl_error($ch);
curl_close($ch);

if ($error) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => $error, 'phone' => $cleanPhone]);
    exit;
}

$data = json_decode($response, true);

if ($httpCode === 200 && isset($data['messages'][0]['id'])) {
    echo json_encode([
        'success'   => true,
        'messageId' => $data['messages'][0]['id'],
        'phone'     => $cleanPhone,
    ]);
} else {
    http_response_code($httpCode ?: 500);
    echo json_encode([
        'success' => false,
        'error'   => $data['error']['message'] ?? $data['message'] ?? $response,
        'phone'   => $cleanPhone,
    ]);
}
