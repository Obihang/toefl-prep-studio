export async function safeFetchJson(url: string, options?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err: any) {
    if (err?.name === 'AbortError' || /abort|timed?\s*out/i.test(String(err?.message || ''))) {
      const abortErr: any = new Error('Provider request timed out after 12 seconds.');
      abortErr.status = 408;
      abortErr.isTimeout = true;
      throw abortErr;
    }
    const netErr: any = new Error('Network connection error. Please check your connection and try again.');
    netErr.status = 0;
    throw netErr;
  }

  const contentType = res.headers.get('content-type');
  const text = await res.text();
  let data: any = null;

  if (contentType && contentType.includes('application/json')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!data) {
    const preview = text.trim().slice(0, 50);
    const msg = preview ? `Server returned plain text: ${preview}...` : `Server had a problem (status ${res.status})`;
    const parseErr: any = new Error(msg);
    parseErr.status = res.status;
    parseErr.text = text;
    throw parseErr;
  }

  if (!res.ok) {
    const errorMsg = data?.error || data?.message || `The server had a problem (status ${res.status}). Try again in a moment.`;
    const err: any = new Error(errorMsg);
    err.status = res.status;
    err.json = data;
    throw err;
  }

  return data;
}
