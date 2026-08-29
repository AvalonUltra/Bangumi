/*
 * @Author: czy0729
 * @Date: 2026-09-06 00:00:00
 */

/**
 * 这两个模糊库只在 Android 侧使用 (源码里仅 .android.tsx 引用, iOS 走 expo-blur),
 * 但 autolinking 默认会把它们的原生代码链进 iOS 包。
 *
 * 两者各自都定义了一个 Objective-C 类 BlurView
 * (@react-native-community/blur 的 BlurView.mm 与 react-native-realtimeblurview
 * 的 BlurView.swift), 同时链接会 duplicate symbol 直接失败。iOS 侧本来就用不到,
 * 排除掉即可, 顺便还省下一块无用的二进制。
 */
module.exports = {
  dependencies: {
    '@react-native-community/blur': {
      platforms: {
        ios: null
      }
    },
    'react-native-realtimeblurview': {
      platforms: {
        ios: null
      }
    }
  }
}
