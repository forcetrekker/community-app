const mod = () => require('utils/isomorphy');

beforeEach(() => jest.resetModules());

test('Client- and server-side checks work properly at the server-side', () => {
  delete process.env.FRONT_END;
  expect(mod().isClientSide()).toBe(false);
  expect(mod().isServerSide()).toBe(true);
});

test('Client- and server-side checks work properly at the client-side', () => {
  process.env.FRONT_END = true;
  expect(mod().isClientSide()).toBe(true);
  expect(mod().isServerSide()).toBe(false);
});

test('isDev() returns true in dev', () => {
  process.env.NODE_ENV = 'development';
  expect(mod().isDev()).toBe(true);
});

test('isDev() returns false in prod', () => {
  process.env.NODE_ENV = 'production';
  expect(mod().isDev()).toBe(false);
});
