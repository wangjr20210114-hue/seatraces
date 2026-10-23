// 管理鸿蒙应用生命周期并加载主页面。

import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void {
    try { windowStage.loadContent('pages/Index'); } catch (error) { console.error('SeaTraces page load failed'); }
  }
}
