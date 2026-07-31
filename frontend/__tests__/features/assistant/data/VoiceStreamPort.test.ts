import { describe, expect, it } from '@jest/globals';

import { FakeWsServer } from '@/dev/fakes/FakeWsServer';
import { WsVoiceStreamPort } from '@/features/assistant/data/VoiceStreamPort';
import { WsClient } from '@/infrastructure/ws/WsClient';

describe('WsVoiceStreamPort with FakeWsServer', () => {
  it('correlates the final parse result to the start request', async () => {
    const server = new FakeWsServer();
    const client = new WsClient({ fakeHandler: server.handleMessage });
    server.attach(client);
    await client.connect();
    const voice = new WsVoiceStreamPort(client);

    const started = await voice.start();
    const result = await voice.end(started.streamId, started.jobId, started.resultRequestId);

    expect(result.draft.title).toBe('语音创建的日程');
    client.close();
  });
});
