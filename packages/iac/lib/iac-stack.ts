import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import * as path from "path";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";

export class IacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
    });

    // ECS Task Execution Role
    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: taskExecutionRole,
      }
    );
    const appContainer = taskDefinition.addContainer("App", {
      containerName: "app",
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, "../../server/"),
        {
          platform: Platform.LINUX_AMD64,
        }
      ),
      essential: true,
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "ecs-blue-green",
      }),
    });
    appContainer.addPortMappings({
      containerPort: 80,
    });

    // Security Group for ECS
    const appSg = new ec2.SecurityGroup(this, "AppSg", {
      vpc: vpc,
      allowAllOutbound: true,
    });

    // Infrastructure Role for ECS
    const infrastructureRole = new iam.Role(this, "InfrastructureRole", {
      assumedBy: new iam.ServicePrincipal("ecs.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonECSInfrastructureRolePolicyForLoadBalancers"
        ),
      ],
    });

    // ECS Service
    const service = new ecs.FargateService(this, "Service", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [appSg],
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: "Private",
      }),
      deploymentStrategy: ecs.DeploymentStrategy.BLUE_GREEN,
      bakeTime: cdk.Duration.minutes(2),
    });

    // Security Group of ALB
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: vpc,
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: "Public",
      }),
    });

    // ALB Target Group Blue
    const appTargetGroupBlue = new elbv2.ApplicationTargetGroup(
      this,
      "AppTargetGroupBlue",
      {
        targetGroupName: "AppTargetGroupBlue",
        vpc: vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: "/",
          port: "80",
          protocol: elbv2.Protocol.HTTP,
        },
      }
    );

    // ALB Target Group Green
    const appTargetGroupGreen = new elbv2.ApplicationTargetGroup(
      this,
      "AppTargetGroupGreen",
      {
        targetGroupName: "AppTargetGroupGreen",
        vpc: vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: "/",
          port: "80",
          protocol: elbv2.Protocol.HTTP,
        },
      }
    );

    // ALB Listener
    const albListener = alb.addListener("AlbListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "Not Found",
      }),
    });
    const albListenerRule = new elbv2.ApplicationListenerRule(
      this,
      "AlbListenerRule",
      {
        listener: albListener,
        priority: 1,
        conditions: [elbv2.ListenerCondition.pathPatterns(["*"])],
        action: elbv2.ListenerAction.forward([appTargetGroupBlue]),
      }
    );

    const albTestListener = alb.addListener("AlbTestListener", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "Not Found",
      }),
    });
    const albTestListenerRule = new elbv2.ApplicationListenerRule(
      this,
      "AlbTestListenerRule",
      {
        listener: albTestListener,
        priority: 1,
        conditions: [elbv2.ListenerCondition.pathPatterns(["*"])],
        action: elbv2.ListenerAction.forward([appTargetGroupGreen]),
      }
    );

    const target = service.loadBalancerTarget({
      containerName: "app",
      containerPort: 80,
      protocol: ecs.Protocol.TCP,
      alternateTarget: new ecs.AlternateTarget("AlternateTarget", {
        alternateTargetGroup: appTargetGroupGreen,
        productionListener:
          ecs.ListenerRuleConfiguration.applicationListenerRule(
            albListenerRule
          ),
        testListener:
          ecs.ListenerRuleConfiguration.applicationListenerRule(
            albTestListenerRule
          ),
        role: infrastructureRole,
      }),
    });
    target.attachToApplicationTargetGroup(appTargetGroupBlue);
  }
}
