# ipa 环境

给不走 Expo 托管、直接 `xcodebuild` 出 unsigned IPA 的 iOS 构建用的依赖集。
`.github/workflows/build-upstream-ipa.yml` 每天用它把上游 tag 打成 IPA，
发到 `upstream-<tag>` release，并更新 `alt_store.json`（AltStore / SideStore 源）。

## 和 packages/ios 的关系

**同一套技术栈**：Expo 54 / RN 0.81 / reanimated 4 / react-native-worklets。

只有一处刻意的差异：`@sdcx/nested-scroll` 这里是 `^1.0.8`，根依赖是 `^0.14.0`。
0.14.0 的 `RNNestedScrollView.m` 用了 `RCTRootContentView`，这个类在 RN 0.86 的新架构下
已经不存在，编译直接报 `unknown type name`。1.0.8 改成了 Fabric codegen 的写法，且
`NestedScrollView` / `NestedScrollViewHeader` / `NestedScrollEvent` 三个上游用到的导出都在。
根依赖写的 `^0.14.0` 在 semver 里够不到 1.x，所以升 57 时漏掉了它。

另外 `react-native.config.js` 把 `@react-native-community/blur` 和
`react-native-realtimeblurview` 排除出 iOS autolinking。这两个库源码里只有
`.android.tsx` 引用（iOS 走 expo-blur），但 autolinking 会把原生代码链进 iOS 包，
而它们各自都定义了一个 Objective-C 类 `BlurView`，同时链接直接 duplicate symbol。
排除之后顺带省掉一块无用二进制，`@react-native-community/blur` 的 podspec 也不再被求值，
它那个 `RCT-Folly (= 2021.06.28.00-v2)` 的硬钉自然也不构成问题。

## 原生工程由 CI 重新生成

**tag 里 checked-in 的 `ios/` 是 Expo 52 时代 prebuild 的产物，在 Expo 54 上是死的。**
SDK 52 时 `EXAppDelegateWrapper` 继承 `RCTAppDelegate`，后者的
`loadReactNativeWindow:` 负责建 `UIWindow`、用 `self.moduleName` 造 rootView、
`makeKeyAndVisible`；SDK 54 改成了 `NSObject`，整个 expo pod 里再没有任何代码
建窗口或调 `startReactNative`——那是应用自己 AppDelegate 的活（Swift 模板）。

结果是那份 `AppDelegate.mm` 编译全绿、启动后什么都没有。所以 workflow 在
`yarn install` 之后跑 `expo prebuild --platform ios --clean`，用当前依赖集
重新生成原生工程，再把项目自己的 NSURLCache 图片缓存作为一条改写补回去。

`prepare-ipa-source.mjs` 因此分两段：`source`（切依赖集 + 改 JS 源码，在
install 之前）和 `native`（prebuild + 原生配置，在 install 之后）。

## iOS SDK 上限是 26

iOS 27 把「未采用 UIScene 生命周期」变成了致命断言，对**链接 iOS 27 SDK** 的
应用在任何 app 代码跑起来之前就 `EXC_BREAKPOINT`。Expo 54 没做 scene 适配
（`ExpoAppDelegate.swift` 里还写着 `TODO: - Configuring and Discarding Scenes`），
而且实测只加一个空的 `UIApplicationSceneManifest` **不足以**过关。

所以 `MAX_SUPPORTED_IOS_SDK_MAJOR = 26`，prepare 检测到更新的 SDK 会直接失败，
而不是产出一个装上去必崩的 IPA。要往上升 Xcode，得先解决 scene 适配。
本地拿新 Xcode 试验可以设 `ALLOW_UNSUPPORTED_IOS_SDK=1` 绕过——产物能在
iOS 27 之前的模拟器里跑，但在 iOS 27 真机上必崩。

## 新架构是硬性要求

reanimated 4 只支持 New Architecture，所以 `ios/Podfile.properties.json` 里
`newArchEnabled` 必须是 `"true"`。prepare 脚本会按 reanimated 大版本核对并纠正
（旧 tag 的压缩包里还是 `false`）。

配套要注意的是 `@react-native-community/blur`：4.2.0 在新架构分支里硬钉
`RCT-Folly (= 2021.06.28.00-v2)`，和 RN 0.81 的 Folly 冲突导致 `pod install`
直接解不出来，已升到 4.4.1。

## 依赖集由谁维护

CI 是从**上游 tag 的压缩包**构建的，压缩包里带的是打 tag 当时的
`packages/ipa/package.json`。所以 workflow 会把仓库里这份（`IPA_PACKAGE_JSON`）
覆盖上去，并打印出改了哪些版本——否则每次升级都要等下一个 tag 才生效。

锁文件同理放在 automation 侧：`.github/ipa/yarn.lock`，配
`.github/ipa/yarn.lock.meta.json` 记录它对应的 `package.json` 的 sha256。
对得上就 `--frozen-lockfile`；对不上就在这份锁上解析，并把刷新后的锁作为
`ipa-lockfile` artifact 传出来，提交回去即可。改了这里的依赖就要重新生成锁文件。

## 本地构建

```
yarn env ipa
yarn install --ignore-engines
npx patch-package --patch-dir packages/ipa/patches
cd ios && pod install
```

```
xcodebuild -workspace Bangumi.xcworkspace -scheme Bangumi -configuration Release -sdk iphoneos CODE_SIGN_IDENTITY=\"\" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO -derivedDataPath build
```

```
yarn make:ipa
```
