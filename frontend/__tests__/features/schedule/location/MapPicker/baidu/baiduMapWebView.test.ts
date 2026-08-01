import { describe, expect, it } from '@jest/globals';

import { buildBaiduMapDocument } from '@/features/schedule/location/MapPicker/baidu/baiduMapWebView';

describe('buildBaiduMapDocument', () => {
  it('embeds the AK and default Shanghai center when no initial location', () => {
    const html = buildBaiduMapDocument('test-ak', null);
    expect(html).toContain(encodeURIComponent('test-ak'));
    expect(html).toContain('31.236305');
    expect(html).toContain('121.480237');
    expect(html).toContain('null');
  });

  it('embeds the provided initial location', () => {
    const html = buildBaiduMapDocument('ak', {
      address: '办公室',
      latitude: 31.1,
      longitude: 121.2,
      name: '办公室',
    });
    expect(html).toContain('31.1');
    expect(html).toContain('121.2');
    expect(html).toContain('办公室');
  });

  it('escapes initial location data for the inline script context', () => {
    const html = buildBaiduMapDocument('ak', {
      address: '</script><script>window.pwned = "&"</script>',
      latitude: 31.1,
      longitude: 121.2,
    });

    expect(html).not.toContain('</script><script>window.pwned');
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003e');
    expect(html).toContain('\\u0026');
  });
});
