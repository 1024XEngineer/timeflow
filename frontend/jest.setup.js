// jest-expo installs fetch lazily; initialize it before the test environment is torn down.
Reflect.get(globalThis, 'fetch');

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Icon = (props) => React.createElement(View, { ...props, testID: props.testID ?? 'icon' });
  return new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === 'string' && key !== '__esModule' ? Icon : undefined),
    },
  );
});

jest.mock('react-native-safe-area-context', () => {
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children }) => children,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  const WebView = React.forwardRef((props, _ref) =>
    React.createElement(View, { testID: 'webview', ...props }),
  );
  WebView.displayName = 'MockWebView';
  return {
    WebView,
  };
});
