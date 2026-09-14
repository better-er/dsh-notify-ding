/**
 * dsh-notify-ding 的宿主入口。
 *
 * 提示音交给系统通知自带，插件不再自行发声，因此本入口没有运行时行为。
 * 之所以还留一个入口文件，是因为客户端模块系统按 Loader entry 扫描
 * dsh.client 声明：entry 指向的宿主模块必须存在，浏览器半身才会被加载。
 *
 * @module dsh-notify-ding
 */

/** 插件名，同时也是配置项 id。 */
export const name = 'dsh-notify-ding'

/** 无宿主行为，仅作为可挂载的宿主入口存在。 */
export function apply(): void {}
