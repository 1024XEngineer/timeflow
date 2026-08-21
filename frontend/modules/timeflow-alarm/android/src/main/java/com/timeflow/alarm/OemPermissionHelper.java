package com.timeflow.alarm;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * 国产 ROM 自启动管理 / MIUI 后台弹出界面——都没有标准 API 能查真实授权状态，
 * 这里能做到的只是"识别厂商 + 带用户跳到对应设置页 + 记一下带没带过"，不是真的
 * granted/denied。组件名是社区经验值，没有官方文档，覆盖不到的机型/版本由
 * 调用方（AlarmModule）退回应用详情页。
 */
final class OemPermissionHelper {

    static final String KIND_AUTOSTART = "autostart";
    static final String KIND_BACKGROUND_POPUP = "backgroundPopup";

    static final String MANUFACTURER_XIAOMI = "xiaomi";
    static final String MANUFACTURER_HUAWEI = "huawei";
    static final String MANUFACTURER_OPPO = "oppo";
    static final String MANUFACTURER_VIVO = "vivo";

    private OemPermissionHelper() {
    }

    /**
     * 只精确匹配这四家已知的 Build.MANUFACTURER 取值（"Xiaomi"/"HUAWEI"/"OPPO"/"vivo"），
     * 不去猜 POCO/Redmi/Honor/OnePlus/Realme/iQOO 这些子品牌是否共用同一套系统包名——
     * 没有把握的机型不识别，好过指向一个可能不存在的 Activity。
     */
    static String detectManufacturer() {
        if (Build.MANUFACTURER == null) return null;
        String manufacturer = Build.MANUFACTURER.trim().toLowerCase();
        if (MANUFACTURER_XIAOMI.equals(manufacturer)) return MANUFACTURER_XIAOMI;
        if (MANUFACTURER_HUAWEI.equals(manufacturer)) return MANUFACTURER_HUAWEI;
        if (MANUFACTURER_OPPO.equals(manufacturer)) return MANUFACTURER_OPPO;
        if (MANUFACTURER_VIVO.equals(manufacturer)) return MANUFACTURER_VIVO;
        return null;
    }

    /**
     * 按厂商 + kind 拼社区经验值组件名；识别不到厂商，或者厂商没有这个 kind 对应的
     * 设置页（比如"后台弹出界面"目前只有小米有），返回 null——调用方退回应用详情页。
     * 这里只负责"拼出 Intent"，不负责 startActivity 是否真的能解析成功（那一步的
     * ActivityNotFoundException 由调用方兜底）。
     */
    static Intent buildOemSettingsIntent(Context context, String manufacturer, String kind) {
        if (manufacturer == null || kind == null) return null;

        if (MANUFACTURER_XIAOMI.equals(manufacturer)) {
            if (KIND_AUTOSTART.equals(kind)) {
                return new Intent().setComponent(new ComponentName(
                        "com.miui.securitycenter",
                        "com.miui.permcenter.autostart.AutoStartManagementActivity"));
            }
            if (KIND_BACKGROUND_POPUP.equals(kind)) {
                Intent intent = new Intent().setComponent(new ComponentName(
                        "com.miui.securitycenter",
                        "com.miui.permcenter.permissions.PermissionsEditorActivity"));
                intent.putExtra("extra_pkgname", context.getPackageName());
                return intent;
            }
            return null;
        }

        if (MANUFACTURER_HUAWEI.equals(manufacturer)) {
            if (KIND_AUTOSTART.equals(kind)) {
                return new Intent().setComponent(new ComponentName(
                        "com.huawei.systemmanager",
                        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
            }
            return null;
        }

        if (MANUFACTURER_OPPO.equals(manufacturer)) {
            if (KIND_AUTOSTART.equals(kind)) {
                return new Intent().setComponent(new ComponentName(
                        "com.coloros.safecenter",
                        "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
            }
            return null;
        }

        if (MANUFACTURER_VIVO.equals(manufacturer)) {
            if (KIND_AUTOSTART.equals(kind)) {
                return new Intent().setComponent(new ComponentName(
                        "com.vivo.permissionmanager",
                        "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
            }
            return null;
        }

        return null;
    }

    static void markGuided(Context context, String kind) {
        prefs(context).edit().putBoolean(guidedKey(kind), true).apply();
    }

    static boolean isGuided(Context context, String kind) {
        return prefs(context).getBoolean(guidedKey(kind), false);
    }

    /** showAlarmOverlay() 每次尝试 addView 都调一次，成功传 false 清掉上一次的失败记录。 */
    static void recordOverlayFailure(Context context, boolean failed) {
        prefs(context).edit().putBoolean(AlarmContract.KEY_OEM_LAST_OVERLAY_FAILED, failed).apply();
    }

    static boolean wasLastOverlayFailure(Context context) {
        return prefs(context).getBoolean(AlarmContract.KEY_OEM_LAST_OVERLAY_FAILED, false);
    }

    private static String guidedKey(String kind) {
        return KIND_AUTOSTART.equals(kind)
                ? AlarmContract.KEY_OEM_AUTOSTART_GUIDED
                : AlarmContract.KEY_OEM_BACKGROUND_POPUP_GUIDED;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(AlarmContract.PREFS_NAME, Context.MODE_PRIVATE);
    }
}
