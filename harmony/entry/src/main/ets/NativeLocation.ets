import { geoLocationManager } from '@kit.LocationKit';
import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { url } from '@kit.ArkTS';

interface LocationReply {
  ok: boolean;
  code?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  at?: number;
}
interface OriginRule { scheme: string; host: string; port: string; path: string; }
interface ProxyRule { urlPermissionList: OriginRule[]; }
interface ProxyPermission { javascriptProxyPermission: ProxyRule; }

export function locationProxyPermission(origin: string): string {
  try {
  const parsed = url.URL.parseURL(origin);
  const rule: ProxyPermission = { javascriptProxyPermission: { urlPermissionList: [{
    scheme: parsed.protocol.replace(':', ''), host: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), path: '/'
  }] } };
  return JSON.stringify(rule);
  } catch (_) { return '{"javascriptProxyPermission":{"urlPermissionList":[]}}'; }
}

export class NativeLocation {
  private context: () => common.UIAbilityContext;
  private allowed: () => boolean;
  constructor(context: () => common.UIAbilityContext, allowed: () => boolean) {
    this.context = context;
    this.allowed = allowed;
  }

  async requestLocation(): Promise<string> {
    return this.readLocation(false);
  }
  async authorizedLocation(): Promise<string> {
    return this.readLocation(true);
  }
  private async readLocation(passive: boolean): Promise<string> {
    let reply: LocationReply = { ok: false, code: 'unavailable' };
    if (!this.allowed()) return JSON.stringify({ ok: false, code: 'permission' } as LocationReply);
    try {
      const manager = abilityAccessCtrl.createAtManager();
      let granted: boolean = false;
      if (passive) {
        const token = this.context().applicationInfo.accessTokenId;
        granted = manager.checkAccessTokenSync(token, 'ohos.permission.LOCATION') === 0 || manager.checkAccessTokenSync(token, 'ohos.permission.APPROXIMATELY_LOCATION') === 0;
      } else {
        const result = await manager.requestPermissionsFromUser(this.context(), ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION']);
        granted = result.authResults.some((v: number) => v === 0);
      }
      if (!granted || !this.allowed()) {
        reply.code = 'permission';
      } else if (!geoLocationManager.isLocationEnabled()) {
        reply.code = 'disabled';
      } else {
        const position = await geoLocationManager.getCurrentLocation({
          priority: geoLocationManager.LocationRequestPriority.FIRST_FIX,
          scenario: geoLocationManager.LocationRequestScenario.UNSET,
          timeoutMs: 12000
        });
        if (this.allowed()) reply = { ok: true, lat: position.latitude, lng: position.longitude, accuracy: position.accuracy, at: Date.now() };
        else reply.code = 'permission';
      }
    } catch (error) {
      const code = (error as BusinessError).code;
      reply.code = code === 201 ? 'permission' : code === 3301100 ? 'disabled' : code === 3301200 ? 'timeout' : 'unavailable';
    }
    return JSON.stringify(reply);
  }
}
