import { jest } from '@jest/globals';

export const mockedScope = {
  setLevel: jest.fn(),
  setTag: jest.fn(),
};

export const init = jest.fn();
export const wrap = <T>(component: T): T => component;
export const setTag = jest.fn();
export const captureMessage = jest.fn();
export const captureException = jest.fn();
export const addBreadcrumb = jest.fn();
export const withScope = jest.fn((callback: (scope: typeof mockedScope) => void) => {
  callback(mockedScope);
});
