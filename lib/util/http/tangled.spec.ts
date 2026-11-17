import * as httpMock from '~test/http-mock.ts';
import * as hostRules from '../host-rules.ts';
import { TangledHttp } from './tangled.ts';

const baseUrl = 'https://api.tangled.org';

describe('util/http/tangled', () => {
  let api: TangledHttp;

  beforeEach(() => {
    api = new TangledHttp();
    // Mimics the platform rule Renovate core registers from the endpoint
    // plus username/password config. The AT Protocol app password is not a
    // valid credential for the appview, so it must never be sent.
    hostRules.add({
      hostType: 'tangled',
      matchHost: baseUrl,
      username: 'bot.akimo.dev',
      password: 'app-password',
    });
  });

  it('sends no hostRules-derived auth to the appview', async () => {
    httpMock
      .scope(baseUrl, { badheaders: ['authorization'] })
      .get('/xrpc/org.tangled.repo.getRepoByName')
      .reply(200, {});

    await expect(
      api.getJsonUnchecked(`${baseUrl}/xrpc/org.tangled.repo.getRepoByName`),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('preserves an explicitly set Bearer token', async () => {
    httpMock
      .scope(baseUrl, {
        reqheaders: { authorization: 'Bearer service-auth-token' },
      })
      .post('/xrpc/com.atproto.repo.createRecord')
      .reply(200, {});

    await expect(
      api.postJson(`${baseUrl}/xrpc/com.atproto.repo.createRecord`, {
        headers: { authorization: 'Bearer service-auth-token' },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('accepts a custom hostType', async () => {
    const customApi = new TangledHttp('custom');
    httpMock
      .scope(baseUrl, { badheaders: ['authorization'] })
      .get('/xrpc/test')
      .reply(200, {});

    await expect(
      customApi.getJsonUnchecked(`${baseUrl}/xrpc/test`),
    ).resolves.toMatchObject({ statusCode: 200 });
  });
});
