package dev.familyhub.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * The daily background check: about once a day, when the phone has a
 * network, ask the hub what is due and show anything not shown yet. It needs
 * no push service, so reminders arrive even if ntfy is down or not installed.
 */
public class DailyCheckJob extends JobService {

  @Override
  public boolean onStartJob(final JobParameters params) {
    new Thread(
            () -> {
              boolean retry = false;
              try {
                Notifier.check(getApplicationContext());
              } catch (Exception e) {
                // No network or the hub is down: Android tries again later.
                retry = true;
              }
              jobFinished(params, retry);
            },
            "family-hub-daily-check")
        .start();
    return true;
  }

  @Override
  public boolean onStopJob(JobParameters params) {
    return true;
  }
}
