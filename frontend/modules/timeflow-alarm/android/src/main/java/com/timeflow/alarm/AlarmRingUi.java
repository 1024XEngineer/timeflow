package com.timeflow.alarm;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.StateSet;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 提醒打断界面：时钟与标题居中。
 * 颜色与 src/shared/theme/index.ts 对齐。
 */
final class AlarmRingUi {
    private static final int COLOR_BACKGROUND = Color.parseColor("#F4F5F1");
    private static final int COLOR_MINT = Color.parseColor("#DDEFE5");
    private static final int COLOR_DEEP = Color.parseColor("#15352B");
    private static final int COLOR_SUB = Color.parseColor("#6C7972");
    private static final int COLOR_LIME = Color.parseColor("#D7F36A");

    private static final String FALLBACK_TITLE = "日程提醒";
    private static final long ENTER_MILLIS = 420L;
    private static final long ENTER_STAGGER_MILLIS = 60L;
    private static final float ENTER_OFFSET_DP = 10f;

    private AlarmRingUi() {
    }

    static int topEdgeColor() {
        return COLOR_MINT;
    }

    static int bottomEdgeColor() {
        return COLOR_BACKGROUND;
    }

    static FrameLayout build(
            Context context,
            String scheduleTitle,
            View.OnClickListener onSnooze,
            View.OnClickListener onConfirm
    ) {
        float d = context.getResources().getDisplayMetrics().density;
        int gutter = Math.round(28 * d);

        TextView clock = text(context, formatClock(), 66, COLOR_DEEP, condensedBold());
        clock.setLetterSpacing(-0.04f);
        clock.setFontFeatureSettings("tnum");
        clock.setGravity(Gravity.CENTER);

        TextView date = text(context, formatDate(), 15, COLOR_SUB, regular());
        date.setGravity(Gravity.CENTER);

        RingRoot root = new RingRoot(context, () -> {
            clock.setText(formatClock());
            date.setText(formatDate());
        });
        root.setBackground(buildBackground());

        TextView brand = text(context, "Timeflow", 36, COLOR_DEEP, bold());
        brand.setLetterSpacing(-0.03f);
        brand.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams brandParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        brandParams.topMargin = Math.round(48 * d);
        root.addView(brand, brandParams);

        TextView moment = text(context, "此刻提醒", 13, COLOR_SUB, medium());
        moment.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams momentParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        momentParams.topMargin = Math.round(92 * d);
        root.addView(moment, momentParams);

        LinearLayout center = new LinearLayout(context);
        center.setOrientation(LinearLayout.VERTICAL);
        center.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams centerParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        );
        centerParams.leftMargin = gutter;
        centerParams.rightMargin = gutter;
        root.addView(center, centerParams);

        center.addView(clock, matchWidth());

        LinearLayout.LayoutParams dateParams = matchWidth();
        dateParams.topMargin = Math.round(14 * d);
        center.addView(date, dateParams);

        View divider = new View(context);
        GradientDrawable dividerBg = new GradientDrawable();
        dividerBg.setColor(COLOR_LIME);
        dividerBg.setCornerRadius(999 * d);
        divider.setBackground(dividerBg);
        LinearLayout.LayoutParams dividerParams = new LinearLayout.LayoutParams(
                Math.round(40 * d),
                Math.round(3 * d)
        );
        dividerParams.gravity = Gravity.CENTER_HORIZONTAL;
        dividerParams.topMargin = Math.round(26 * d);
        center.addView(divider, dividerParams);

        TextView title = text(context, resolveTitle(scheduleTitle), 32, COLOR_DEEP, bold());
        title.setMaxLines(3);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setLineSpacing(0f, 1.25f);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = matchWidth();
        titleParams.topMargin = Math.round(20 * d);
        center.addView(title, titleParams);

        LinearLayout actions = new LinearLayout(context);
        actions.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams actionsParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
        );
        actionsParams.leftMargin = gutter;
        actionsParams.rightMargin = gutter;
        actionsParams.bottomMargin = Math.round(28 * d);
        root.addView(actions, actionsParams);

        TextView snooze = buildActionButton(
                context,
                d,
                "延后 10 分钟",
                COLOR_MINT,
                onSnooze
        );
        LinearLayout.LayoutParams snoozeParams = matchWidth();
        snoozeParams.height = Math.round(54 * d);
        actions.addView(snooze, snoozeParams);

        TextView confirm = buildActionButton(
                context,
                d,
                "确认",
                COLOR_LIME,
                onConfirm
        );
        LinearLayout.LayoutParams confirmParams = matchWidth();
        confirmParams.height = Math.round(58 * d);
        confirmParams.topMargin = Math.round(12 * d);
        actions.addView(confirm, confirmParams);

        if (animatorsEnabled(context)) {
            View[] sequence = {brand, moment, center, actions};
            root.post(() -> enter(sequence, d));
        }

        return root;
    }

    private static TextView buildActionButton(
            Context context,
            float d,
            String label,
            int fillColor,
            View.OnClickListener onClick
    ) {
        TextView button = text(context, label, 18, COLOR_DEEP, bold());
        button.setGravity(Gravity.CENTER);
        button.setContentDescription(label);
        button.setClickable(true);
        button.setFocusable(true);
        button.setElevation(3 * d);
        button.setOnClickListener(onClick);

        StateListDrawable fill = new StateListDrawable();
        GradientDrawable focused = pill(d, Math.round(2 * d), fillColor);
        GradientDrawable normal = pill(d, 0, fillColor);
        fill.addState(new int[]{android.R.attr.state_focused}, focused);
        fill.addState(StateSet.WILD_CARD, normal);
        button.setBackground(new RippleDrawable(
                ColorStateList.valueOf(Color.argb(38, 21, 53, 43)),
                fill,
                null
        ));
        return button;
    }

    private static GradientDrawable pill(float d, int strokeWidth, int fillColor) {
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(fillColor);
        pill.setCornerRadius(20 * d);
        if (strokeWidth > 0) {
            pill.setStroke(strokeWidth, COLOR_DEEP);
        }
        return pill;
    }

    private static void enter(View[] sequence, float d) {
        for (int index = 0; index < sequence.length; index++) {
            View view = sequence[index];
            view.setAlpha(0f);
            view.setTranslationY(ENTER_OFFSET_DP * d);
            view.animate()
                    .alpha(1f)
                    .translationY(0f)
                    .setStartDelay(index * ENTER_STAGGER_MILLIS)
                    .setDuration(ENTER_MILLIS)
                    .setInterpolator(new DecelerateInterpolator(1.6f))
                    .start();
        }
    }

    private static String resolveTitle(String scheduleTitle) {
        return scheduleTitle == null || scheduleTitle.isEmpty() ? FALLBACK_TITLE : scheduleTitle;
    }

    private static String formatClock() {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date());
    }

    private static String formatDate() {
        return new SimpleDateFormat("M月d日 EEEE", Locale.CHINA).format(new Date());
    }

    private static TextView text(Context context, String value, float sizeSp, int color, Typeface face) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        view.setTypeface(face);
        return view;
    }

    private static Typeface condensedBold() {
        return Typeface.create("sans-serif-condensed", Typeface.BOLD);
    }

    private static Typeface medium() {
        return Typeface.create("sans-serif-medium", Typeface.NORMAL);
    }

    private static Typeface bold() {
        return Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD);
    }

    private static Typeface regular() {
        return Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL);
    }

    private static GradientDrawable buildBackground() {
        return new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{COLOR_MINT, COLOR_BACKGROUND, COLOR_BACKGROUND, COLOR_BACKGROUND}
        );
    }

    private static LinearLayout.LayoutParams matchWidth() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private static boolean animatorsEnabled(Context context) {
        return Settings.Global.getFloat(
                context.getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
        ) > 0f;
    }

    private static final class RingRoot extends FrameLayout {
        private static final long TICK_MILLIS = 20_000L;

        private final Handler handler = new Handler(Looper.getMainLooper());
        private final Runnable onTick;
        private final Runnable ticker = new Runnable() {
            @Override
            public void run() {
                onTick.run();
                handler.postDelayed(this, TICK_MILLIS);
            }
        };

        RingRoot(Context context, Runnable onTick) {
            super(context);
            this.onTick = onTick;
        }

        @Override
        protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            handler.postDelayed(ticker, TICK_MILLIS);
        }

        @Override
        protected void onDetachedFromWindow() {
            handler.removeCallbacks(ticker);
            super.onDetachedFromWindow();
        }
    }
}
