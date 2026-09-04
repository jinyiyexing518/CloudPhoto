import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  deploymentMarkerResponse,
  deploymentMarkerUnavailableResponse,
  readDeploymentSha,
} from "../../utils/deploymentMarker";

type DeploymentShaReader = () => Promise<string>;

export function createGetDeploymentHandler(
  readSha: DeploymentShaReader = readDeploymentSha
) {
  return async (
    _request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    try {
      return deploymentMarkerResponse(await readSha());
    } catch (error) {
      context.error("getDeployment error:", error);
      return deploymentMarkerUnavailableResponse();
    }
  };
}

app.http("getDeployment", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "deployment",
  handler: createGetDeploymentHandler(),
});
