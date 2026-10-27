#!/bin/sh
exec /usr/bin/python3 -I -B /usr/local/lib/axialmuse-release/tat-entry.py 3<"$0"
exit 127
# AXIALMUSE-TAT-PARAMETERS-V1
workflowRunId={{workflowRunId}}
artifactId={{artifactId}}
commitSha={{commitSha}}
artifactDigest={{artifactDigest}}
releaseContentSha256={{releaseContentSha256}}
# AXIALMUSE-TAT-END
