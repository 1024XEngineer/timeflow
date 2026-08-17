package com.timeflow.alarm;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.provider.Settings;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;

import java.util.Calendar;

/**
 * 以「今天」为刻度尺：每小时一刻度，每六小时加长刻度，
 * 青柠指针落在响铃那一分钟。已过去的刻度变淡，未到的刻度更实。
 *
 * 这是提醒屏上唯一的结构装置，也是唯一标出「这次打断落在一天何处」的元素。
 */
final class DayRulerView extends View {
    private static final int HOURS_PER_DAY = 24;
    private static final int HOURS_PER_QUARTER = 6;
    private static final long BREATH_MILLIS = 1_700L;
    private static final int ALPHA_AHEAD = 56;
    private static final int ALPHA_SPENT = 23;
    private static final float HALO_ALPHA_TIGHT = 0.30f;
    private static final float HALO_ALPHA_WIDE = 0.08f;
    private static final float BREATH_AT_REST = 0.4f;

    private final Paint tickPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint needlePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint haloPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final float hourTickLength;
    private final float quarterTickLength;
    private final float tickThickness;
    private final float needleThickness;
    private final float haloTightHeight;
    private final float haloWideHeight;
    private final float haloRadius;
    private final boolean breathing;

    private ValueAnimator breathAnimator;
    private float breath;
    private float dayFraction;

    DayRulerView(Context context, int tickColor, int needleColor) {
        super(context);
        float density = context.getResources().getDisplayMetrics().density;
        hourTickLength = 9 * density;
        quarterTickLength = 17 * density;
        tickThickness = 1.5f * density;
        needleThickness = 3 * density;
        haloTightHeight = 8 * density;
        haloWideHeight = 16 * density;
        haloRadius = 8 * density;

        tickPaint.setColor(tickColor);
        needlePaint.setColor(needleColor);
        haloPaint.setColor(needleColor);

        breathing = animatorsEnabled(context);
        breath = breathing ? 0f : BREATH_AT_REST;
        syncToClock();
    }

    /** 重新读取墙上时钟，使长响过程中指针仍与当前时刻同步。 */
    void syncToClock() {
        Calendar now = Calendar.getInstance();
        int minutesIntoDay = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        dayFraction = minutesIntoDay / (float) (HOURS_PER_DAY * 60);
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float height = getHeight();
        float width = getWidth();
        if (height <= 0 || width <= 0) {
            return;
        }

        float needleY = clampToTrack(height * dayFraction, height, needleThickness);
        for (int hour = 0; hour <= HOURS_PER_DAY; hour++) {
            float y = clampToTrack(height * hour / HOURS_PER_DAY, height, tickThickness);
            float length = hour % HOURS_PER_QUARTER == 0 ? quarterTickLength : hourTickLength;
            tickPaint.setAlpha(y < needleY ? ALPHA_SPENT : ALPHA_AHEAD);
            drawBar(canvas, y, length, tickThickness, tickThickness, tickPaint);
        }

        float haloHeight = haloTightHeight + (haloWideHeight - haloTightHeight) * breath;
        float haloAlpha = HALO_ALPHA_TIGHT + (HALO_ALPHA_WIDE - HALO_ALPHA_TIGHT) * breath;
        haloPaint.setAlpha(Math.round(haloAlpha * 255f));
        drawBar(canvas, needleY, width, haloHeight, haloRadius, haloPaint);
        drawBar(canvas, needleY, width, needleThickness, needleThickness, needlePaint);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (!breathing || breathAnimator != null) {
            return;
        }
        breathAnimator = ValueAnimator.ofFloat(0f, 1f);
        breathAnimator.setDuration(BREATH_MILLIS);
        breathAnimator.setRepeatMode(ValueAnimator.REVERSE);
        breathAnimator.setRepeatCount(ValueAnimator.INFINITE);
        breathAnimator.setInterpolator(new AccelerateDecelerateInterpolator());
        breathAnimator.addUpdateListener(animator -> {
            breath = (float) animator.getAnimatedValue();
            invalidate();
        });
        breathAnimator.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (breathAnimator != null) {
            breathAnimator.cancel();
            breathAnimator = null;
        }
        super.onDetachedFromWindow();
    }

    private static void drawBar(
            Canvas canvas,
            float centerY,
            float length,
            float thickness,
            float radius,
            Paint paint
    ) {
        canvas.drawRoundRect(
                0f,
                centerY - thickness / 2f,
                length,
                centerY + thickness / 2f,
                radius,
                radius,
                paint
        );
    }

    /** 保证一天的首末刻度仍完整落在列内。 */
    private static float clampToTrack(float y, float height, float thickness) {
        float inset = thickness / 2f;
        return Math.min(Math.max(y, inset), height - inset);
    }

    private static boolean animatorsEnabled(Context context) {
        return Settings.Global.getFloat(
                context.getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
        ) > 0f;
    }
}
