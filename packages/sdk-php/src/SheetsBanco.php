<?php

declare(strict_types=1);

namespace SheetsBanco;

/**
 * sheets.banco PHP SDK
 *
 * Usage:
 *   $client = new SheetsBanco\Client("https://your-api.com", "your-api-id");
 *   $client->setAuth(bearer: "your-token");
 *   $rows = $client->getRows();
 *   $client->createRows([["name" => "Alice", "age" => "30"]]);
 */
class Client
{
    private string $baseUrl;
    private string $apiId;
    private array $headers = ['Content-Type: application/json'];

    public function __construct(string $baseUrl, string $apiId)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->apiId = $apiId;
    }

    public function setAuth(
        ?string $bearer = null,
        ?string $basicUser = null,
        ?string $basicPass = null,
        ?string $apiKey = null
    ): self {
        if ($bearer) {
            $this->headers[] = "Authorization: Bearer $bearer";
        } elseif ($basicUser && $basicPass) {
            $cred = base64_encode("$basicUser:$basicPass");
            $this->headers[] = "Authorization: Basic $cred";
        }
        if ($apiKey) {
            $this->headers[] = "X-Api-Key: $apiKey";
        }
        return $this;
    }

    private function endpoint(string $path = ''): string
    {
        return "{$this->baseUrl}/api/v1/{$this->apiId}{$path}";
    }

    private function request(string $method, string $path, ?array $body = null, array $params = []): mixed
    {
        $url = $this->endpoint($path);
        $filtered = array_filter($params, fn($v) => $v !== null);
        if (!empty($filtered)) {
            $url .= '?' . http_build_query($filtered);
        }

        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $this->headers);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }

        $response = curl_exec($ch);
        $statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $data = json_decode($response, true);

        if ($statusCode >= 400) {
            throw new \RuntimeException(
                $data['message'] ?? "HTTP $statusCode error",
                $statusCode
            );
        }

        return $data;
    }

    // ── Read ──

    public function getRows(array $options = []): array
    {
        return $this->request('GET', '', null, [
            'sheet' => $options['sheet'] ?? null,
            'limit' => isset($options['limit']) ? (string)$options['limit'] : null,
            'offset' => isset($options['offset']) ? (string)$options['offset'] : null,
            'sort_by' => $options['sort_by'] ?? null,
            'sort_order' => $options['sort_order'] ?? null,
            'cast_numbers' => ($options['cast_numbers'] ?? false) ? 'true' : null,
            'version' => isset($options['version']) ? (string)$options['version'] : null,
            'source' => $options['source'] ?? null,
        ]);
    }

    public function getColumns(?string $sheet = null): array
    {
        return $this->request('GET', '/keys', null, ['sheet' => $sheet]);
    }

    public function getCount(?string $sheet = null): int
    {
        $result = $this->request('GET', '/count', null, ['sheet' => $sheet]);
        return $result['rows'] ?? 0;
    }

    public function search(array $filters, string $mode = 'and', array $options = []): array
    {
        $path = $mode === 'and' ? '/search' : '/search_or';
        $params = array_merge($filters, [
            'sheet' => $options['sheet'] ?? null,
            'limit' => isset($options['limit']) ? (string)$options['limit'] : null,
            'offset' => isset($options['offset']) ? (string)$options['offset'] : null,
        ]);
        return $this->request('GET', $path, null, $params);
    }

    // ── Write ──

    public function createRows(array $rows, bool $sync = false, ?string $sheet = null): array
    {
        // If single associative array, wrap in array
        if (isset($rows[0]) === false && !empty($rows)) {
            $rows = [$rows];
        }
        return $this->request('POST', '', ['data' => $rows], [
            'sync' => $sync ? 'true' : null,
            'sheet' => $sheet,
        ]);
    }

    public function updateRows(string $column, string $value, array $data, bool $sync = false, ?string $sheet = null): array
    {
        return $this->request('PATCH', "/$column/$value", ['data' => $data], [
            'sync' => $sync ? 'true' : null,
            'sheet' => $sheet,
        ]);
    }

    public function deleteRows(string $column, string $value, bool $sync = false, ?string $sheet = null): array
    {
        return $this->request('DELETE', "/$column/$value", null, [
            'sync' => $sync ? 'true' : null,
            'sheet' => $sheet,
        ]);
    }

    public function clearAll(bool $sync = false, ?string $sheet = null): array
    {
        return $this->request('DELETE', '/all', null, [
            'sync' => $sync ? 'true' : null,
            'sheet' => $sheet,
        ]);
    }

    // ── Batch ──

    public function batchUpdate(array $filters, array $data, string $filterMode = 'and', bool $sync = false, ?string $sheet = null): array
    {
        return $this->request('POST', '/batch/update', [
            'filters' => $filters,
            'data' => $data,
            'filter_mode' => $filterMode,
        ], ['sync' => $sync ? 'true' : null, 'sheet' => $sheet]);
    }

    public function batchDelete(array $filters, string $filterMode = 'and', bool $sync = false, ?string $sheet = null): array
    {
        return $this->request('POST', '/batch/delete', [
            'filters' => $filters,
            'filter_mode' => $filterMode,
        ], ['sync' => $sync ? 'true' : null, 'sheet' => $sheet]);
    }
}
