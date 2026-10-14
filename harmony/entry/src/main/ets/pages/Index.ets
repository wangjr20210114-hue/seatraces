import { webview } from '@kit.ArkWeb';
import { common, abilityAccessCtrl } from '@kit.AbilityKit';
import { backendOrigin, sameBackendOrigin } from '../BackendPolicy';
import { NativeLocation, locationProxyPermission } from '../NativeLocation';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State address: string = 'https://trip.seatraces.com';
  @State draftAddress: string = 'https://trip.seatraces.com';
  @State showSettings: boolean = false;
  @State loadError: boolean = false;
  locationBridge: NativeLocation = new NativeLocation(
    () => this.getUIContext().getHostContext() as common.UIAbilityContext,
    () => sameBackendOrigin(this.controller.getUrl(), this.address));

  aboutToDisappear(): void {
    try { this.controller.deleteJavaScriptRegister('SeaTracesLocation'); } catch (_) {}
  }

  onBackPress(): boolean {
    if (this.showSettings) {
      this.draftAddress = this.address;
      this.showSettings = false;
      return true;
    }
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (_) {}
    return false;
  }

  private openExternal(url: string): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    context.startAbility({ action: 'ohos.want.action.viewData', uri: url }).catch(() => {
      this.getUIContext().getPromptAction().showToast({ message: '未找到可打开此链接的应用' });
    });
  }

  build() {
    Column() {
      Row() {
        Text('SeaTraces · 一路去玩').fontSize(11).fontColor('#183C40')
        Blank()
        Button('连接设置').fontSize(11).height(27).fontColor('#183E3A').backgroundColor('#E8EEDC')
          .onClick(() => { this.draftAddress = this.address; this.showSettings = !this.showSettings; })
      }.width('100%').padding({ left: 16, right: 16, top: 6, bottom: 6 })
      if (this.showSettings) {
        Column({ space: 8 }) {
          Text('团队服务：https://trip.seatraces.com。本机开发可切换到 http://127.0.0.1:8788，并映射模拟器 8788 端口。')
            .fontSize(11).fontColor('#6C8174')
          TextInput({ text: this.draftAddress, placeholder: 'https://trip.seatraces.com' })
            .fontSize(13).onChange((value: string) => { this.draftAddress = value; })
          Button('连接并刷新').fontSize(12).onClick(() => {
            const target = backendOrigin(this.draftAddress);
            if (target) {
              this.address = target;
              this.controller.loadUrl(this.address);
              this.loadError = false;
              this.showSettings = false;
            } else {
              this.getUIContext().getPromptAction().showToast({ message: '请填写 HTTPS 前端域名；不含账号、路径或参数。本机使用 http://127.0.0.1:8788' });
            }
          })
        }.padding(16).backgroundColor('#EFF3E6')
      }
      if (this.loadError) {
        Column({ space: 12 }) {
          Text('旅行页面暂未连接').fontSize(18).fontColor('#183C40')
          Text('请检查网络连接；本机开发时需启动电脑前端并映射端口。').fontSize(13).fontColor('#6C8174')
          Button('重新加载 ↻').fontSize(14).fontColor('#183C40').backgroundColor('#27CFB8')
            .onClick(() => { this.loadError = false; this.controller.loadUrl(this.address); })
        }.padding(24).width('100%').backgroundColor('#FFFDF2')
      }
      // Keep the map and the native shell in one composited canvas on the emulator.
      Web({ src: this.address, controller: this.controller, renderMode: RenderMode.SYNC_RENDER })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .geolocationAccess(true)
        .javaScriptProxy({ object: this.locationBridge, name: 'SeaTracesLocation', methodList: [],
          asyncMethodList: ['requestLocation', 'authorizedLocation'], controller: this.controller,
          permission: locationProxyPermission(this.address) })
        .onGeolocationShow((event) => {
          if (event) {
            const requestedBackend = this.address;
            if (!sameBackendOrigin(event.origin, requestedBackend)) {
              event.geolocation.invoke(event.origin, false, false);
              return;
            }
            const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
            abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context,
              ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'])
              .then((result) => {
                const allowed = requestedBackend === this.address && sameBackendOrigin(event.origin, this.address) &&
                  result.authResults.some((value: number) => value === 0);
                event.geolocation.invoke(event.origin, allowed, false);
              }).catch(() => { event.geolocation.invoke(event.origin, false, false); });
          }
        })
        .onLoadIntercept((event) => {
          if (event) {
            const url = event.data.getRequestUrl();
            if (url.startsWith('https://uri.amap.com/') || url.startsWith('https://www.google.com/maps/')) {
              this.openExternal(url);
              return true;
            }
          }
          return false;
        })
        .onErrorReceive((event) => {
          if (event && event.request.isMainFrame()) { this.loadError = true; }
        })
        .onPageBegin(() => { this.loadError = false; })
        .layoutWeight(1)
        .width('100%')
    }.width('100%').height('100%').backgroundColor('#F7F8F2')
  }
}
