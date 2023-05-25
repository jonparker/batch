import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import fetch from "node-fetch";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION,
});
const cloudwatchClient = new CloudWatchClient({
  region: process.env.AWS_REGION,
});
const secretsManagerClient = new SecretsManagerClient({
  region: process.env.AWS_REGION,
});

const MAX_ITERATOR_AGE = 1000;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 5000; // 5 seconds

const processBatch = async (
  batch: { ID: string; Name: string; Interests: string }[]
) => {
  for (const row of batch) {
    const { ID, Name, Interests } = row;

    // Make the POST request using the ID and Interests
    const postRequestParams = {
      url: `https://www.example.com/${ID}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": (await getAPIKeyFromSecretsManager()) || "",
      },
      body: JSON.stringify({ Name, Interests }),
    };

    try {
      const response = await fetch(postRequestParams.url, {
        method: postRequestParams.method,
        headers: postRequestParams.headers,
        body: postRequestParams.body,
      });

      if (response.status === 200) {
        console.log(`POST request succeeded for ID: ${ID}`);
      } else {
        console.log(`POST request failed for ID: ${ID}`);
      }
    } catch (error) {
      console.log(`POST request error for ID: ${ID}`, error);
    }
  }
};

const delay = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const getIteratorAge = async () => {
  const lambdaFunctionName = process.env.OTHER_LAMBDA_FUNCTION_NAME;
  const namespace = "AWS/Lambda";
  const metricName = "IteratorAge";

  const currentTime = new Date();
  const startTime = new Date(currentTime.getTime() - 60000); // Start time: 1 minute ago

  const params = {
    Namespace: namespace,
    MetricName: metricName,
    Dimensions: [
      {
        Name: "FunctionName",
        Value: lambdaFunctionName,
      },
    ],
    StartTime: startTime,
    EndTime: currentTime,
    Period: 60, // 1 minute
    Statistics: ["Average"], // Retrieve the average statistic
  };

  try {
    const response = await cloudwatchClient.send(
      new GetMetricStatisticsCommand(params)
    );
    const datapoints = response.Datapoints;

    if (!datapoints || datapoints.length === 0) {
      return 0; // No datapoints found, return 0 as default value
    }

    const maxAverage = Math.max(...datapoints.map((dp) => dp.Average || 0));
    return maxAverage;
  } catch (error) {
    console.log(`Error retrieving IteratorAge metric: ${error}`);
    return 0;
  }
};

const getAPIKeyFromSecretsManager = async () => {
  const secretName = process.env.SECRET_NAME;
  const params = {
    SecretId: secretName,
  };

  try {
    const response = await secretsManagerClient.send(
      new GetSecretValueCommand(params)
    );
    const secretValue = response.SecretString;
    return secretValue;
  } catch (error) {
    console.log(`Error retrieving API key from Secrets Manager: ${error}`);
    return "";
  }
};

export const handler = async (event: any, context: any) => {
  try {
    const bucketName = event.Records[0].s3.bucket.name;
    const objectKey = event.Records[0].s3.object.key;

    const getObjectParams = {
      Bucket: bucketName,
      Key: objectKey,
    };

    const s3Object = await s3.send(new GetObjectCommand(getObjectParams));
    const csvData = s3Object?.Body?.toString();
    const csvRows = csvData?.split("\n").map((row) => {
      const [ID, Name, Interests] = row.split(",");
      return { ID, Name, Interests };
    });

    if (csvRows === undefined) {
      return;
    }

    let currentIndex = 0;
    while (currentIndex < csvRows.length) {
      const batch = csvRows.slice(currentIndex, currentIndex + BATCH_SIZE);
      await processBatch(batch);

      // Check the maximum average iterator age
      const iteratorAge = await getIteratorAge();
      if (iteratorAge > MAX_ITERATOR_AGE) {
        console.log(
          "Maximum IteratorAge exceeded. Adding a delay before processing the next batch."
        );
        await delay(BATCH_DELAY_MS);
      }

      currentIndex += BATCH_SIZE;
    }

    return "Processing completed.";
  } catch (error) {
    console.log("Error:", error);
    throw error;
  }
};
