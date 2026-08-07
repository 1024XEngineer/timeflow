import { registerRootComponent } from 'expo';

import App from './App';

// 注册根组件会向应用注册表登记主组件。
// 无论通过开发容器还是原生构建加载应用，它都会完成必要的运行环境设置。
registerRootComponent(App);
