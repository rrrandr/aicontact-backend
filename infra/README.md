# Infrastructure

## weekly-report-sns-publish.yaml

Grants the backend instance role permission to publish the weekly billing
summary to the existing operations SNS topic, and nothing else: one action
(`sns:Publish`) on one named resource. It cannot create topics, subscribe
anyone, read subscriber addresses, or publish to any other topic.

The topic and its confirmed email subscription already exist and are not
managed here, so nothing about who receives the report lives in this
repository, and applying this cannot change it.

Before deploying, verify both parameters:

```sh
aws sns list-topics --profile aicontact-sso
aws ec2 describe-instances --instance-ids i-057ae18a360c34da6 \
  --query "Reservations[].Instances[].IamInstanceProfile" --profile aicontact-sso
```

Then check what would change, and only then deploy:

```sh
aws cloudformation deploy \
  --template-file infra/weekly-report-sns-publish.yaml \
  --stack-name aicontact-weekly-report-sns-publish \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides InstanceRoleName=<role name> \
  --no-execute-changeset --profile aicontact-sso
```

`--no-execute-changeset` prints a change set to review; drop it to apply.

To remove the grant, delete the stack. The report stops being delivered and is
retained and retried, which is visible in `weekly_reports` rather than silent.
