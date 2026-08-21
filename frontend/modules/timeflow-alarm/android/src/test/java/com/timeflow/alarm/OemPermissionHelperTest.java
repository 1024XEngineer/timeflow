package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

/**
 * 覆盖厂商识别归一化、已知/未知厂商 + kind 组合下的 Intent 构造、guided/失败标志位
 * 的读写往返。不覆盖 startActivity 是否真的能解析到对应 Activity——那部分只有
 * 真机才能验证，这几个组件名是社区经验值，没有官方文档。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public class OemPermissionHelperTest {

    private Context context;
    private String originalManufacturer;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        originalManufacturer = Build.MANUFACTURER;
    }

    @After
    public void tearDown() {
        ReflectionHelpers.setStaticField(Build.class, "MANUFACTURER", originalManufacturer);
    }

    @Test
    public void detectManufacturer_recognizesTheFourKnownBrands() {
        setManufacturer("Xiaomi");
        assertEquals("xiaomi", OemPermissionHelper.detectManufacturer());

        setManufacturer("HUAWEI");
        assertEquals("huawei", OemPermissionHelper.detectManufacturer());

        setManufacturer("OPPO");
        assertEquals("oppo", OemPermissionHelper.detectManufacturer());

        setManufacturer("vivo");
        assertEquals("vivo", OemPermissionHelper.detectManufacturer());
    }

    @Test
    public void detectManufacturer_isCaseInsensitive() {
        setManufacturer("xIAOMI");
        assertEquals("xiaomi", OemPermissionHelper.detectManufacturer());
    }

    @Test
    public void detectManufacturer_returnsNullForUnrecognizedOrSubBrands() {
        // 子品牌（POCO/Redmi/Honor/OnePlus 等）没有被显式覆盖——不确定它们是否
        // 共用同一套系统包名，宁可不识别也不指向一个可能不存在的 Activity。
        setManufacturer("POCO");
        assertNull(OemPermissionHelper.detectManufacturer());

        setManufacturer("Google");
        assertNull(OemPermissionHelper.detectManufacturer());
    }

    @Test
    public void buildOemSettingsIntent_xiaomiAutostart_pointsAtSecurityCenter() {
        Intent intent = OemPermissionHelper.buildOemSettingsIntent(
                context, "xiaomi", OemPermissionHelper.KIND_AUTOSTART);

        assertEquals("com.miui.securitycenter", intent.getComponent().getPackageName());
        assertEquals(
                "com.miui.permcenter.autostart.AutoStartManagementActivity",
                intent.getComponent().getClassName());
    }

    @Test
    public void buildOemSettingsIntent_xiaomiBackgroundPopup_carriesThePackageNameExtra() {
        Intent intent = OemPermissionHelper.buildOemSettingsIntent(
                context, "xiaomi", OemPermissionHelper.KIND_BACKGROUND_POPUP);

        assertEquals(
                "com.miui.permcenter.permissions.PermissionsEditorActivity",
                intent.getComponent().getClassName());
        assertEquals(context.getPackageName(), intent.getStringExtra("extra_pkgname"));
    }

    @Test
    public void buildOemSettingsIntent_returnsNullForBackgroundPopupOnNonXiaomiBrands() {
        // 目前只有小米这一项，华为/OPPO/vivo 没有对应设置页。
        assertNull(OemPermissionHelper.buildOemSettingsIntent(
                context, "huawei", OemPermissionHelper.KIND_BACKGROUND_POPUP));
        assertNull(OemPermissionHelper.buildOemSettingsIntent(
                context, "oppo", OemPermissionHelper.KIND_BACKGROUND_POPUP));
        assertNull(OemPermissionHelper.buildOemSettingsIntent(
                context, "vivo", OemPermissionHelper.KIND_BACKGROUND_POPUP));
    }

    @Test
    public void buildOemSettingsIntent_returnsNullForUnrecognizedManufacturer() {
        assertNull(OemPermissionHelper.buildOemSettingsIntent(
                context, null, OemPermissionHelper.KIND_AUTOSTART));
    }

    @Test
    public void buildOemSettingsIntent_huaweiOppoVivoAutostart_haveDistinctComponents() {
        Intent huawei = OemPermissionHelper.buildOemSettingsIntent(
                context, "huawei", OemPermissionHelper.KIND_AUTOSTART);
        Intent oppo = OemPermissionHelper.buildOemSettingsIntent(
                context, "oppo", OemPermissionHelper.KIND_AUTOSTART);
        Intent vivo = OemPermissionHelper.buildOemSettingsIntent(
                context, "vivo", OemPermissionHelper.KIND_AUTOSTART);

        assertEquals("com.huawei.systemmanager", huawei.getComponent().getPackageName());
        assertEquals("com.coloros.safecenter", oppo.getComponent().getPackageName());
        assertEquals("com.vivo.permissionmanager", vivo.getComponent().getPackageName());
    }

    @Test
    public void guidedFlags_startFalse_thenPersistAfterMarking() {
        assertFalse(OemPermissionHelper.isGuided(context, OemPermissionHelper.KIND_AUTOSTART));
        assertFalse(OemPermissionHelper.isGuided(context, OemPermissionHelper.KIND_BACKGROUND_POPUP));

        OemPermissionHelper.markGuided(context, OemPermissionHelper.KIND_AUTOSTART);

        assertTrue(OemPermissionHelper.isGuided(context, OemPermissionHelper.KIND_AUTOSTART));
        assertFalse(
                "标两个不同 kind 不该互相污染",
                OemPermissionHelper.isGuided(context, OemPermissionHelper.KIND_BACKGROUND_POPUP));
    }

    @Test
    public void overlayFailureFlag_recordsAndClears() {
        assertFalse(OemPermissionHelper.wasLastOverlayFailure(context));

        OemPermissionHelper.recordOverlayFailure(context, true);
        assertTrue(OemPermissionHelper.wasLastOverlayFailure(context));

        OemPermissionHelper.recordOverlayFailure(context, false);
        assertFalse(
                "下一次成功展示应该清掉上一次失败的记录",
                OemPermissionHelper.wasLastOverlayFailure(context));
    }

    private void setManufacturer(String value) {
        ReflectionHelpers.setStaticField(Build.class, "MANUFACTURER", value);
    }
}
