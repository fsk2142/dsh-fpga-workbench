/**
 * 最小 React 类型声明。
 *
 * ## 为什么不装 `@types/react`
 *
 * 客户端只用了 **5 个 API**：`createElement` / `useState` / `useRef` / `useEffect`，
 * 以及 `React.FC` 风格的组件写法。而 `@types/react` 会拉进一整套 JSX 运行时类型、
 * 事件类型、`CSSProperties`……对一个不用 JSX（全部走 `h()`）的插件来说，
 * 那些类型不但用不上，还会和宿主的 React 版本耦合。
 *
 * 工单也交代过「不要在迁移中升级依赖版本」，装类型包同样属于改 `devDependencies`。
 * 所以这里只声明**真正用到的形状**——这是"用未知类型收窄"的正面用法：
 * 明确列出接口，而不是让它们隐式 any。
 *
 * ## 这个声明的边界
 *
 * 它**不是**完整的 React 类型。如果以后客户端开始用 `useMemo` / `useCallback` /
 * JSX，需要在这里补上，或者那时再考虑装 `@types/react`。
 *
 * 注意：`tsdown` 只做转译不做类型检查，所以这些声明**不会进产物**；它们只服务于
 * `tsc --noEmit`。
 */

declare module "react" {
  /** 一个 React 元素（不透明句柄，客户端只把它传给宿主）。 */
  interface ReactElement {
    readonly type: unknown;
    readonly props: unknown;
    readonly key: string | null;
  }

  /** 子节点：元素、字符串、数字、布尔/null（渲染为无）、或它们的数组。 */
  type ReactNode = ReactElement | string | number | boolean | null | undefined | ReactNode[];

  /** `createElement` 的 props：允许任意 HTML 属性、事件处理器、`key`。 */
  interface Attributes {
    key?: string | number;
    [attribute: string]: unknown;
  }

  /** `createElement` 的签名（组件可以是函数或字符串标签）。 */
  function createElement(
    type: string | ((props: never) => ReactElement),
    props?: Attributes | null,
    ...children: ReactNode[]
  ): ReactElement;

  /** `useState` 的 setter：接受新值或基于旧值的更新函数。 */
  type SetStateAction<S> = S | ((previous: S) => S);
  type Dispatch<A> = (value: A) => void;

  function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];

  /** `useRef` 返回的对象：`.current` 可读可写。 */
  interface MutableRefObject<T> {
    current: T;
  }

  function useRef<T>(initial: T): MutableRefObject<T>;

  /** `useEffect` 的清理函数与依赖数组。 */
  type EffectCallback = () => void | (() => void);
  type DependencyList = readonly unknown[];

  function useEffect(effect: EffectCallback, deps?: DependencyList): void;

  /** 默认导出：客户端用 `import React from "react"`。 */
  const React: {
    createElement: typeof createElement;
    useState: typeof useState;
    useRef: typeof useRef;
    useEffect: typeof useEffect;
  };
  export default React;

  export { createElement, useEffect, useRef, useState };
  export type { DependencyList, Dispatch, EffectCallback, MutableRefObject, ReactElement, ReactNode, SetStateAction };
}
