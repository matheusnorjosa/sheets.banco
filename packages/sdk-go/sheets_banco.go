// Package sheetsbanco provides a Go client for the sheets.banco REST API.
//
// Usage:
//
//	client := sheetsbanco.New("https://your-api.com", "your-api-id")
//	client.SetBearerToken("your-token")
//	rows, err := client.GetRows(nil)
package sheetsbanco

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a sheets.banco API client.
type Client struct {
	BaseURL    string
	APIId      string
	HTTPClient *http.Client
	headers    map[string]string
}

// Row is a map of column name to value.
type Row map[string]string

// Error represents an API error.
type Error struct {
	Message    string `json:"message"`
	Code       string `json:"code"`
	StatusCode int    `json:"statusCode"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("sheets.banco %d: %s", e.StatusCode, e.Message)
}

// New creates a new sheets.banco client.
func New(baseURL, apiId string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIId:   apiId,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		headers: map[string]string{
			"Content-Type": "application/json",
		},
	}
}

// SetBearerToken sets bearer token auth.
func (c *Client) SetBearerToken(token string) {
	c.headers["Authorization"] = "Bearer " + token
}

// SetAPIKey sets API key auth.
func (c *Client) SetAPIKey(key string) {
	c.headers["X-Api-Key"] = key
}

func (c *Client) endpoint(path string) string {
	return fmt.Sprintf("%s/api/v1/%s%s", c.BaseURL, c.APIId, path)
}

func (c *Client) doRequest(method, path string, body interface{}, params url.Values) (json.RawMessage, error) {
	u := c.endpoint(path)
	if len(params) > 0 {
		u += "?" + params.Encode()
	}

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, u, bodyReader)
	if err != nil {
		return nil, err
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		var apiErr Error
		if json.Unmarshal(data, &apiErr) == nil && apiErr.Message != "" {
			apiErr.StatusCode = resp.StatusCode
			return nil, &apiErr
		}
		return nil, &Error{Message: string(data), StatusCode: resp.StatusCode}
	}

	return json.RawMessage(data), nil
}

// QueryOptions holds optional query parameters.
type QueryOptions struct {
	Sheet       string
	Limit       int
	Offset      int
	SortBy      string
	SortOrder   string
	CastNumbers bool
	Version     int
	Source      string
}

func (o *QueryOptions) toValues() url.Values {
	v := url.Values{}
	if o == nil {
		return v
	}
	if o.Sheet != "" {
		v.Set("sheet", o.Sheet)
	}
	if o.Limit > 0 {
		v.Set("limit", fmt.Sprintf("%d", o.Limit))
	}
	if o.Offset > 0 {
		v.Set("offset", fmt.Sprintf("%d", o.Offset))
	}
	if o.SortBy != "" {
		v.Set("sort_by", o.SortBy)
	}
	if o.SortOrder != "" {
		v.Set("sort_order", o.SortOrder)
	}
	if o.CastNumbers {
		v.Set("cast_numbers", "true")
	}
	if o.Version > 0 {
		v.Set("version", fmt.Sprintf("%d", o.Version))
	}
	if o.Source != "" {
		v.Set("source", o.Source)
	}
	return v
}

// GetRows fetches all rows.
func (c *Client) GetRows(opts *QueryOptions) ([]Row, error) {
	data, err := c.doRequest("GET", "", nil, opts.toValues())
	if err != nil {
		return nil, err
	}
	var rows []Row
	return rows, json.Unmarshal(data, &rows)
}

// GetColumns returns column names.
func (c *Client) GetColumns(sheet string) ([]string, error) {
	v := url.Values{}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	data, err := c.doRequest("GET", "/keys", nil, v)
	if err != nil {
		return nil, err
	}
	var cols []string
	return cols, json.Unmarshal(data, &cols)
}

// CountResult holds the row count.
type CountResult struct {
	Rows int `json:"rows"`
}

// GetCount returns the row count.
func (c *Client) GetCount(sheet string) (int, error) {
	v := url.Values{}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	data, err := c.doRequest("GET", "/count", nil, v)
	if err != nil {
		return 0, err
	}
	var result CountResult
	return result.Rows, json.Unmarshal(data, &result)
}

// Search finds rows matching filters.
func (c *Client) Search(filters map[string]string, mode string, opts *QueryOptions) ([]Row, error) {
	path := "/search"
	if mode == "or" {
		path = "/search_or"
	}
	v := opts.toValues()
	for k, val := range filters {
		v.Set(k, val)
	}
	data, err := c.doRequest("GET", path, nil, v)
	if err != nil {
		return nil, err
	}
	var rows []Row
	return rows, json.Unmarshal(data, &rows)
}

// CreateRows adds one or more rows.
func (c *Client) CreateRows(rows []Row, sync bool, sheet string) (json.RawMessage, error) {
	v := url.Values{}
	if sync {
		v.Set("sync", "true")
	}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	return c.doRequest("POST", "", map[string]interface{}{"data": rows}, v)
}

// UpdateRows updates rows where column=value.
func (c *Client) UpdateRows(column, value string, data Row, sync bool, sheet string) (json.RawMessage, error) {
	v := url.Values{}
	if sync {
		v.Set("sync", "true")
	}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	return c.doRequest("PATCH", "/"+column+"/"+value, map[string]interface{}{"data": data}, v)
}

// DeleteRows deletes rows where column=value.
func (c *Client) DeleteRows(column, value string, sync bool, sheet string) (json.RawMessage, error) {
	v := url.Values{}
	if sync {
		v.Set("sync", "true")
	}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	return c.doRequest("DELETE", "/"+column+"/"+value, nil, v)
}

// ClearAll removes all data rows.
func (c *Client) ClearAll(sync bool, sheet string) (json.RawMessage, error) {
	v := url.Values{}
	if sync {
		v.Set("sync", "true")
	}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	return c.doRequest("DELETE", "/all", nil, v)
}

// BatchUpdate updates rows matching filters.
func (c *Client) BatchUpdate(filters, data map[string]string, filterMode string, sync bool, sheet string) (json.RawMessage, error) {
	v := url.Values{}
	if sync {
		v.Set("sync", "true")
	}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	return c.doRequest("POST", "/batch/update", map[string]interface{}{
		"filters": filters, "data": data, "filter_mode": filterMode,
	}, v)
}

// BatchDelete deletes rows matching filters.
func (c *Client) BatchDelete(filters map[string]string, filterMode string, sync bool, sheet string) (json.RawMessage, error) {
	v := url.Values{}
	if sync {
		v.Set("sync", "true")
	}
	if sheet != "" {
		v.Set("sheet", sheet)
	}
	return c.doRequest("POST", "/batch/delete", map[string]interface{}{
		"filters": filters, "filter_mode": filterMode,
	}, v)
}
