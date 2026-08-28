// 必须在根组件注册前加载，确保 TaskManager.defineTask 进入顶层作用域。
//
// 系统围栏任务（timeflow-geofence）已经删除，只剩这一个常驻位置任务。它原来只靠
// createAppServices → ReminderGuardCoordinator 的 import 链间接加载——进程被杀之后
// 系统靠这个任务把 JS 引擎拉起来时，defineTask 必须已经跑过，不能指望某条业务
// import 链恰好先到，所以在入口显式声明。
import './src/infrastructure/location/reminderGuardTask';

import { registerRootComponent } from 'expo';

import { initSentry, wrapRoot } from './src/infrastructure/observability/initSentry';
import App from './App';

initSentry();

// 注册根组件会向应用注册表登记主组件。
// 无论通过开发容器还是原生构建加载应用，它都会完成必要的运行环境设置。
registerRootComponent(wrapRoot(App));
